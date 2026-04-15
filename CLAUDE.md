# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is brAIn

**Bridged Reactive Artificial Intelligence Network** — A framework of autonomous interconnected nodes (LLM, code, MCP services) that communicate via a pub/sub message bus. Inspired by brain architecture: each node runs in a loop, can be preempted by higher-priority messages, and the network topology can be rewired at runtime.

## Commands

```bash
pnpm start              # Launch API (port 3000) + Dashboard (port 5173) in parallel
pnpm dev:api            # Backend only (NestJS watch mode)
pnpm dev:dashboard      # Frontend only (Vite HMR)
pnpm build              # Build all packages (must build SDK first, then core, then api/dashboard)
pnpm lint               # ESLint strict — must pass with 0 errors AND 0 warnings
pnpm lint:fix           # Auto-fix
pnpm clean              # Remove all dist/
pnpm test               # Run all vitest tests
```

Run specific tests:
```bash
npx vitest run tests/memory-handler.test.ts       # Single test file
npx vitest run tests/memory-*.test.ts              # Pattern match
```

Infrastructure (optional for dev):
```bash
docker compose up -d    # Redis + PostgreSQL
ollama pull gemma4:e4b  # LLM model for brain/analyst
ollama pull qwen3-embedding:0.6b  # Embedding model for vector memory
```

## Architecture

### Monorepo (pnpm workspaces)

```
packages/sdk    → @brain/sdk        Pure types: NodeHandler, NodeContext, Message, etc.
packages/core   → @brain/core       Engine: BusService, Runners, Registry, Authority
packages/api    → @brain/api        NestJS REST + Socket.IO gateway
packages/dashboard → @brain/dashboard  React 19 + React Flow + d3-force + Tailwind v4
nodes/*         → Node packages     Each is an independent handler + config.json
```

**Dependency flow**: `sdk` ← `core` ← `api`. Dashboard imports `sdk` only. Nodes import `sdk` only.

### Core engine (packages/core)

**BrainService** is the orchestrator. It composes:
- **BusService** — Pub/sub with wildcard topic matching (`alerts.*` matches all depths). Each subscription has its own Mailbox (configurable max_size + retention: `latest` or `lowest_priority`).
- **Runner hierarchy** — See "Runner architecture" below.
- **SleepService** — Manages wake conditions (topic match, timer, any message). Safety-net tick every 5s catches race conditions. Sleeping nodes consume zero resources.
- **TypeRegistry** — Scans `nodes/` directory at bootstrap, loads `config.json` per type, stores filesystem paths for dynamic `import()` at spawn time.
- **InstanceRegistry** — Tracks running node instances, emits state change events.
- **AuthorityService** — 3 levels (BASIC=0, ELEVATED=1, ROOT=2). Targeted actions (kill, stop, rewire) require strictly higher authority than target.

All services extend EventEmitter3. BrainService forwards events to the NestJS WebSocket gateway.

### Runner architecture (packages/core/src/runner/)

Runners use a **template method pattern** with a factory:

```
BaseRunner (abstract)        — lifecycle, timers, busy lock, sleep/wake, context builder
  ├── ServiceRunner          — run once per message batch → auto-sleep [any]
  └── LLMRunner              — budget-based iteration loop with attention reset
```

**`RunnerType` enum** + `createRunner()` factory selects the runner based on node tags:
- Tag `"llm"` → `LLMRunner`
- Otherwise → `ServiceRunner`

**ServiceRunner**: message arrives → handler called once → auto-sleep. Wakes on next message.

**LLMRunner**: message arrives → handler called in a budget loop (default 5 iterations):
- New messages during execution **reset the budget** (fresh attention)
- `ctx.state._system_hint` injected each iteration with budget info
- Budget warning at 3 iterations remaining
- Handler can `ctx.sleep()` voluntarily at any time
- Budget exhausted → forced sleep (configurable duration, default 30s)
- Wake from sleep → fresh budget

**Handler timeout**: 60s default, configurable via `config_overrides.handler_timeout_ms`.

### Node contract

A node is a package in `nodes/` with:
- `config.json` — name, tags, default_authority, default_subscriptions, default_publishes, has_ui, supports_transport
- `src/handler.ts` — exports `handler: NodeHandler` (or `default`)
- `package.json` — main points to `dist/handler.js`, depends on `@brain/sdk`
- `ui/index.html` (optional) — served at `/nodes/:id/ui/` if `has_ui: true`

Handler signature: `(ctx: NodeContext) => Promise<void>`. The context provides:

- `ctx.respond(content, metadata?)` — publish to the node's configured `response_topic` or `default_publishes[0]`. **Preferred for service nodes.**
- `ctx.publish(topic, msg)` — publish to a specific topic (use `respond()` unless you need explicit routing)
- `ctx.messages` — unread messages for this iteration
- `ctx.readMessages(opts?)` — read from mailbox with filters
- `ctx.subscribe(topic)` / `ctx.unsubscribe(topic)`
- `ctx.sleep(conditions)` — request sleep with wake conditions
- `ctx.state` — persistent key-value state across iterations (includes `_system_hint`, `_iterations_remaining`, `_woke_from_sleep` injected by LLMRunner)
- `ctx.log(level, message)` — per-node log buffer

Handlers that don't use `await` should return `Promise.resolve()` instead of being `async` (to satisfy `require-await` rule).

### Brain node (nodes/brain/)

The central consciousness/orchestrator. Key modules:

- `handler.ts` — LLM step loop: calls model → parses tool calls → executes → feeds result back. Publishes responses via `respond()`. Sleeps on expected response topics after `publish_message`.
- `tools.ts` — Tool execution: `publish_message` validates topics (returns error + available_topics if no listener), routes through `message-formatter.ts`.
- `tool-parser.ts` — Hardened JSON parser for small LLMs: handles trailing commas, single quotes, unquoted keys, markdown fences, field name variants (`tool`/`tool_name`, `args`/`arguments`/`parameters`).
- `message-formatter.ts` — Topic aliases (`memory.store` → `mem.store`) + dynamic response topic discovery from live network. No hardcoded service list.
- `ui/index.html` — Config panel (model, max_steps, system prompt override), logs, conversation view. Polls every 1.5s, skips focused fields.

### API layer (packages/api)

Single `BrainService` instance created in AppModule factory, injected into all controllers. Controllers are thin wrappers:
- `NodesController` → spawn/kill/stop/start/wake + `PATCH :id/config` (update config_overrides, `null` deletes keys) + logs + mailboxes
- `NodeUiController` → `POST :id/ui/send` (publish message) + `GET :id/ui/messages` (conversation) + static file server for node UIs
- `TypesController` → register/unregister/list via TypeRegistry
- `NetworkController` → snapshot + message history + providers + devmode + seed/reset
- `DashboardGateway` → Socket.IO relay of BrainService events to frontend

### Dashboard (packages/dashboard)

Vite proxies `/nodes`, `/types`, `/network`, `/socket.io` to `localhost:3000`. Uses its own `tsconfig.json` (ESNext modules, react-jsx) — does NOT extend `tsconfig.base.json`.

State managed via custom hooks (`useNetwork`, `useMessages`, `useMessageFlows`, `useSelectedNode`, `useNodeTypes`) that combine REST fetches + Socket.IO live updates.

### Memory subsystem

Three-layer memory architecture:

- **memory** (KV store) — Fast key-value with tags. Expects JSON: `{"key":"x","value":"y","tags":["z"]}`. Search splits query into words, matches against keys (underscore-split), values, and tags. Falls back to returning all entries when store is small and no match.
- **memory-vector** (vector store) — LanceDB + Ollama embeddings (`qwen3-embedding:0.6b`, 1024d). Supports store, search (cosine similarity), and directory indexing.
- **memory-proxy** (intelligent gateway) — LLM-powered. Receives natural language on `mem.ask`/`mem.store`, reformulates queries, broadcasts to both KV and vector backends, synthesizes results.

The brain should always go through `mem.store`/`mem.ask` (the proxy), never `memory.store` directly. The `message-formatter.ts` aliases enforce this as a safety net.

## Tests

Test files live in `tests/` at the repo root. Framework: vitest.

```
tests/
  bus.test.ts                    — BusService, topic matching, mailbox
  registry.test.ts               — TypeRegistry, InstanceRegistry
  memory-handler.test.ts         — Memory KV handler (21 tests): CRUD, search, error messages
  memory-vector-handler.test.ts  — Vector handler (11 tests): store/search with mocked embeddings
  memory-vector-integration.test.ts — E2E with real Ollama embeddings (12 tests, skips if Ollama down)
  http-bridge-handler.test.ts    — HTTP bridge (15 tests): URL/JSON parsing, errors, config
  brain-node.test.ts             — Brain node integration (requires LLM)
  developer.test.ts              — Developer node (requires CLI agents)
```

Handler tests use a mock `NodeContext` with `respond()`, `publish()`, `sleep()` stubs. The mock `respond()` should push to the `published` array with the node's expected response topic.

## Code conventions

### Strict ESLint (0 errors, 0 warnings required)

- **No `any`** — use proper types or `unknown`
- **No `console.*`** — use `pino` (core/nodes) or NestJS `Logger` (api)
- **No `eslint-disable`** — `noInlineConfig: true` enforced globally
- **No `!` assertions** — extract to a local variable with a null check instead
- **`import type`** — enforced via `consistent-type-imports`
- **`readonly`** — enforced on all private properties that aren't reassigned
- **Explicit return types** — on all functions (except expressions/higher-order)
- **`react-hooks/exhaustive-deps`** — error level, deps must be complete
- **`prefer-const`**, **`eqeqeq`**, **`no-floating-promises`**, **`require-await`**
- **max-lines: 300** — split files if they exceed this

### Logging

```typescript
// In @brain/core or node packages:
import { logger } from "./logger";          // or from "@brain/core"
logger.info({ key: "val" }, "message");

// In @brain/api:
import { Logger } from "@nestjs/common";
private readonly log = new Logger(MyClass.name);
this.log.log("message");
```

### TypeScript configs

- Backend packages (sdk, core, api, nodes): CommonJS (`module: "commonjs"`) via `tsconfig.base.json`
- Dashboard: ESNext modules (`module: "ESNext"`, `moduleResolution: "bundler"`)
- API adds `emitDecoratorMetadata` + `experimentalDecorators` for NestJS
- `vite.config.ts` is excluded from ESLint and not included in dashboard tsconfig

### Environment

Config via env vars (see `.env.example`): `API_PORT`, `LOG_LEVEL`, `POSTGRES_*`, `REDIS_*`. No dotenv — environment is pre-populated or injected via docker-compose.

Ollama models: `OLLAMA_HOST` (default `http://localhost:11434`), `OLLAMA_EMBED_MODEL` (default `qwen3-embedding:0.6b`).
