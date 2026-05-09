# AGENTS.md

Project context for AI coding assistants working in this repository.
Keep it concise — when it drifts, the assistant either hallucinates or
re-discovers the same thing every conversation.

## What is brAIn

**Bus-Reactive Ambient Intelligent Nodes** — a runtime for autonomous
nodes that share a NATS pub/sub bus. Each node runs in a loop, sleeps
when idle, can be preempted by higher-criticality messages, and can
live in this process or on a remote `brain-agent` joined to the same
broker.

## Install

End-user / fresh checkout — bootstraps brAIn + brAIn-store + an empty
storeprojects/ in one shot, then runs `pnpm install`:

```bash
npm create brain                 # → ./brain/
npm create brain my-instance     # → ./my-instance/
```

Source for the bootstrapper lives in `scripts/installer/` (published to npm
as `create-brain`). See its [README](./scripts/installer/README.md).

Manual / contributors:

```bash
git clone https://github.com/tibzejoker/brAIn && cd brAIn && pnpm install
```

## Commands

```bash
pnpm start              # API (port 3000) + Dashboard (port 5173) in parallel
pnpm dev:api            # Backend only (custom dev-supervisor — auto-respawns
                        # on process.exit so the bind/token toggles work)
pnpm dev:dashboard      # Frontend only (Vite HMR)
pnpm build              # Build all packages (sdk → core → api/agent/dashboard)
pnpm lint               # ESLint strict — must pass with 0 errors AND 0 warnings
pnpm test               # vitest, all suites
pnpm kill-orphans       # cleanup leaked dev processes / ports
pnpm kill-ports         # blunter port cleanup

pnpm brain list                  # marketplace registry — installed + available
pnpm brain pull <name>           # install a node from brAIn-store
pnpm brain remove <name> [--yes] # uninstall a node (whole sister repo) or seed
```

Node-specific dev scripts (e.g. `dev:voice`, `setup:gaze`, `dev:vocal-chat`)
live in their respective sister repos (`brAIn-perception`, etc.) — not in
this package.json.

## Repo layout

```
packages/sdk        → @brain/sdk        Pure types: NodeHandler, NodeContext, Message
packages/core       → @brain/core       Engine: BusService + NatsBusService, BrokerService,
                                        Runners, Registry, Authority, Store
packages/api        → @brain/api        NestJS REST + Socket.IO gateway
packages/agent      → @brain/agent      brain-agent CLI — remote-host node runtime
packages/dashboard  → @brain/dashboard  React 19 + React Flow + Tailwind v4
packages/python-sdk → brain-web         Python helper for nodes that speak the bus
                                        over WebSocket (transport: "web")
nodes/_dynamic/*    → custom nodes you author locally (auto-registered)
seeds/*.yaml        → starter network definitions
scripts/brain.mjs   → CLI for marketplace operations
scripts/installer/  → `create-brain` package — published to npm separately
../brAIn-store      → marketplace registry (auto-cloned by postinstall)
../storeprojects/brAIn-{essentials,memory,tools,llm,ui,perception}
                    → sister repos contributing node types via pnpm-workspace
                      sibling globs. Pulled on demand via `pnpm brain pull`.
```

**Dependency flow**: `sdk` ← `core` ← `api` / `agent`. Dashboard imports `sdk`
only. Nodes import `sdk` only. Sister repos use `workspace:*` for `@brain/sdk`
+ `@brain/core` and resolve through brAIn's pnpm-workspace.

## Bus + broker

The framework always runs on NATS. At boot:

1. `BrokerService` either spawns the bundled `nats-server` Go binary
   (`packages/core/bin/nats-server`, downloaded by postinstall) or accepts
   an external URL via `BRAIN_NATS_URL`.
2. Bind address is read from `data/broker.json` — defaults to `127.0.0.1`,
   togglable to `0.0.0.0` via the dashboard's "Open to LAN" button.
3. Auth token is persisted in SQLite (`kv_settings.broker_token`,
   auto-generated on first boot, rotatable from the dashboard). Passed
   to nats-server via `--auth <token>` and to clients via
   `BRAIN_NATS_TOKEN`.
4. `NatsBusService` connects to the URL the broker announced.

Useful env knobs: `BRAIN_BROKER_PORT` (pin the embedded broker port across
restarts), `BRAIN_NATS_URL` (skip embedded broker, join an external one),
`BRAIN_NATS_TOKEN`, `BRAIN_NATS_PREFIX`, `BRAIN_SKIP_NATS_DOWNLOAD=1`.

`BusService` is exported but **only as a test fixture** — production code
always goes through NATS.

Dev mode: `pnpm dev:api` runs `packages/api/scripts/dev-supervisor.mjs`,
which runs `tsc -w` + spawns `node dist/main.js` and respawns on clean
exit. Required because `nest start --watch` doesn't restart the child on
`process.exit(0)`, and the bind / token toggle endpoints rely on exit-then-
respawn to apply changes.

## Core engine

`BrainService` composes:

- **BusService / NatsBusService** — `IBusService` impl. Wildcard topic
  matching (`alerts.*` matches all depths). Per-subscription mailbox
  (`max_size` + `latest` / `lowest_priority` retention). Causal traces
  (`trace_id` + `parent_id`, queryable + replayable).
- **TypeRegistry** — scans node directories at bootstrap, loads
  `config.json` per type, stores filesystem paths for dynamic `import()`
  at spawn time. Sister-repo paths are auto-discovered (`brAIn-essentials`
  through `brAIn-perception`).
- **InstanceRegistry** — running node instances, emits state changes.
- **SleepService** — wake conditions (topic, timer, any). Safety-net tick
  every 5s. Sleeping nodes consume zero CPU.
- **AuthorityService** — 3 levels (BASIC=0, ELEVATED=1, ROOT=2). Targeted
  actions (kill/stop/rewire) require strictly higher authority.
- **AgentDirectory** — tracks remote `brain-agent` announcements on
  `brain.agents.discover`. Drops entries past TTL + cleans up the API's
  remote-node stubs.
- **MCPBridge** — installs MCP message routing on the bus (works with
  `mcp-config` + `mcp-server` from brAIn-essentials).
- **StoreService** — clone+checkout sister repos at pinned refs, verify
  per-file SHA-256 checksums, run pnpm install + build. Same logic
  ported into `scripts/brain.mjs` so the CLI works without the API.

`killAll()` routes through `killNode()` per id so DB rows are deleted —
otherwise seed apply would leak rows that would resurrect on the next
restart.

## Runners

`packages/core/src/runner/` — template method pattern + factory:

```
BaseRunner (abstract)        — lifecycle, busy lock, sleep/wake, ctx builder
  ├── ServiceRunner          — handler called once per message → auto-sleep [any]
  └── LLMRunner              — budget loop (default 5 iter), new messages reset
                               the budget, exhausted → forced sleep
```

`createRunner()` picks based on tags (`"llm"` → LLMRunner, else
ServiceRunner). Handler timeout 60s default, override via
`config_overrides.handler_timeout_ms`.

**Preemption**: a higher-criticality message lands while a handler is
running → runner aborts via `ctx.signal` (an `AbortSignal` LLM/CLI/MCP
nodes pass to their long-running calls), next handler invocation has
`ctx.wasPreempted = true` + `ctx.preemptionContext`.

## Node contract

A node is a directory with:

- `config.json` — `name`, `tags`, `default_authority`, `default_priority`,
  `default_subscriptions` (each requires a `description` — DB
  `NOT NULL`), `default_publishes`, `has_ui`, `supports_transport`
- `src/handler.ts` — exports `handler: NodeHandler` (or `default`),
  optional `onSpawn`, `teardown`
- `package.json` — `main: "dist/handler.js"`, depends on `@brain/sdk`
- `ui/index.html` (optional) — served at `/nodes/:id/ui/` if `has_ui: true`

`ctx.respond(content, metadata?)` publishes to `response_topic` (or
`default_publishes[0]`). `ctx.publish(topic, msg)` for explicit routing.
`ctx.state` is persistent KV across iterations. `ctx.dataDir` is a
per-node SQLite-friendly directory (`data/<node-id>/`). `ctx.sleep()`
voluntarily.

Handlers without `await` must return `Promise.resolve()` (not be `async`)
to satisfy `require-await`.

## API layer

Single `BrainService` instance + a `BrokerService` provider, injected
into thin controllers:

- `NodesController` — spawn/kill/stop/start/wake + `PATCH :id/config` +
  `PATCH :id/position` + logs/mailboxes/dead-letters
- `NodeUiController` — `POST :id/ui/send` + `GET :id/ui/messages` +
  static UI server
- `NetworkController` — snapshot + history + traces (+ replay) + seeds +
  reset + transport (broker URL, mode, bind, lan_ips, token) +
  bind toggle + token rotate + devmode + tickAll
- `SeedsController` — list + apply (+ `?merge=true`)
- `StoreController` — index, nodes, candidates, install, refresh,
  upstream-status, installed-updates, seeds, install seed
- `AgentsController` — list announcing brain-agents
- `MCPController` / `MCPOAuthController` — MCP wiring
- `DashboardGateway` — Socket.IO relay of bus events. Reshapes
  `node:spawned` payloads to match REST `/network` shape (subscriptions
  as `{id, pattern}`).

`main.ts` calls `app.enableShutdownHooks()` so `OnModuleDestroy` fires
the broker's graceful stop on SIGTERM/SIGINT.

## Dashboard

Vite proxies `/nodes`, `/types`, `/network`, `/socket.io`, `/store`,
`/agents`, `/mcp` to localhost:3000. Own `tsconfig.json` (ESNext,
react-jsx) — does NOT extend `tsconfig.base.json`.

State managed via custom hooks (`useNetwork`, `useMessages`,
`useMessageFlows`, `useSelectedNode`, `useNodeTypes`, `useMarketplace`)
combining REST fetches + Socket.IO live updates. The Distributed tab
shows broker URL + bind toggle + LAN IPs + a one-liner agent snippet
(`BRAIN_NATS_URL=… BRAIN_NATS_TOKEN=… npx brain-agent`) + the rotate-token
button.

Stale compiled `vite.config.js` shadows `.ts` if Vite ever recompiles —
gitignored explicitly.

## Tests

`tests/` at the repo root. Vitest `globalSetup` (`tests/_setup/nats-broker.ts`)
spawns one `nats-server` for the whole session and exposes
`BRAIN_TEST_NATS_URL`. Tests that exercise NATS routing read it; tests
that don't use `BusService` directly as a fast in-memory fixture.

Areas covered: bus + matcher + mailbox; broker (embedded + external,
double-start, port collision, missing binary); registry + dynamic
scanner + type validator; runners (lifecycle, resilience, teardown,
preemption — unit + LLM E2E); NATS bus (local + cross-instance,
auth, anti-loop, traces); remote spawn end-to-end via NATS; agent +
agent directory; MCP (in-process + public-server E2E); store; tool
parser; message formatter; child-server hygiene; brain node, developer,
memory subsystem (gated on Ollama / CLI agents).

Skip flags: `RUN_LLM_E2E=1`, `RUN_MCP_E2E=1`. Some legacy test files
import handlers from `nodes/<name>/...` paths that moved into sister
repos — those will fail until they're either migrated to the sister
repos or rewritten.

## Code conventions

### Strict ESLint (0 errors, 0 warnings required)

- **No `any`** — use proper types or `unknown`
- **No `console.*`** — use `pino` (core/nodes) or NestJS `Logger` (api)
- **No `eslint-disable`** — `noInlineConfig: true` enforced globally
- **No `!` assertions** — extract to a local with a null check instead
- **`import type`** — enforced via `consistent-type-imports`
- **`readonly`** — required on private properties that aren't reassigned
- **Explicit return types** — on all functions (except expressions)
- **`react-hooks/exhaustive-deps`** — error level
- **`prefer-const`**, **`eqeqeq`**, **`no-floating-promises`**, **`require-await`**
- **max-lines: 300** — split files if they exceed this

### Logging

```typescript
// In @brain/core or node packages:
import { logger } from "./logger";
logger.info({ key: "val" }, "message");

// In @brain/api:
import { Logger } from "@nestjs/common";
private readonly log = new Logger(MyClass.name);
this.log.log("message");
```

### TypeScript

- Backend (sdk, core, api, agent, nodes): CommonJS (`module: "commonjs"`)
  via `tsconfig.base.json`
- Dashboard: ESNext (`module: "ESNext"`, `moduleResolution: "bundler"`)
- API + agent add `emitDecoratorMetadata` + `experimentalDecorators` for
  NestJS / decorators

### Environment

`API_PORT` (default 3000), `LOG_LEVEL`, `BRAIN_DB_PATH`, `BRAIN_NODES_DIR`,
`BRAIN_EXTRA_NODES_DIRS`, `BRAIN_SEEDS_DIR`, `BRAIN_BROKER_PORT`,
`BRAIN_BROKER_PREFS_PATH`, `BRAIN_NATS_URL`, `BRAIN_NATS_TOKEN`,
`BRAIN_NATS_PREFIX`, `BRAIN_SKIP_NATS_DOWNLOAD`, `BRAIN_NO_STORE_CLONE`.
No dotenv loading — environment is pre-populated.

Ollama (when nodes need it): `OLLAMA_HOST` (default
`http://localhost:11434`), `OLLAMA_EMBED_MODEL` (default
`qwen3-embedding:0.6b`).
