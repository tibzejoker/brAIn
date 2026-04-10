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
```

Infrastructure (optional for dev):
```bash
docker compose up -d    # Redis + PostgreSQL
```

## Architecture

### Monorepo (pnpm workspaces)

```
packages/sdk    → @brain/sdk        Pure types: NodeHandler, NodeContext, Message, etc.
packages/core   → @brain/core       Engine: BusService, NodeRunner, Registry, Authority
packages/api    → @brain/api        NestJS REST + Socket.IO gateway
packages/dashboard → @brain/dashboard  React 19 + React Flow + d3-force + Tailwind v4
nodes/*         → Node packages     Each is an independent handler + config.json
```

**Dependency flow**: `sdk` ← `core` ← `api`. Dashboard imports `sdk` only. Nodes import `sdk` only.

### Core engine (packages/core)

**BrainService** is the orchestrator. It composes:
- **BusService** — Pub/sub with wildcard topic matching (`alerts.*` matches all depths). Each subscription has its own Mailbox (configurable max_size + retention: `latest` or `lowest_priority`).
- **NodeRunner** — Per-node execution loop: collect messages → build NodeContext → call handler → post-iteration (sleep/throttle). Idle throttle: 0→1s→2s→5s→10s backoff, resets on message arrival.
- **SleepService** — Manages wake conditions (topic match, timer, any message). Sleeping nodes consume zero resources.
- **TypeRegistry** — Scans `nodes/` directory at bootstrap, loads `config.json` per type, stores filesystem paths for dynamic `import()` at spawn time.
- **InstanceRegistry** — Tracks running node instances, emits state change events.
- **AuthorityService** — 3 levels (BASIC=0, ELEVATED=1, ROOT=2). Targeted actions (kill, stop, rewire) require strictly higher authority than target.

All services extend EventEmitter3. BrainService forwards events to the NestJS WebSocket gateway.

### Node contract

A node is a package in `nodes/` with:
- `config.json` — name, tags, default_authority, default_subscriptions, interval, supports_transport
- `src/handler.ts` — exports `handler: NodeHandler` (or `default`)
- `package.json` — main points to `dist/handler.js`, depends on `@brain/sdk`

Handler signature: `(ctx: NodeContext) => Promise<void>`. The context provides: `messages`, `readMessages()`, `publish()`, `subscribe()`, `sleep()`, `callLLM()`, `callTool()`, `state` (persistent across iterations).

Handlers that don't use `await` should return `Promise.resolve()` instead of being `async` (to satisfy `require-await` rule).

### API layer (packages/api)

Single `BrainService` instance created in AppModule factory, injected into all controllers. Controllers are thin wrappers:
- `NodesController` → spawn/kill/stop/start/wake via BrainService
- `TypesController` → register/unregister/list via TypeRegistry
- `NetworkController` → snapshot + message history via BusService
- `DashboardGateway` → Socket.IO relay of BrainService events to frontend

### Dashboard (packages/dashboard)

Vite proxies `/nodes`, `/types`, `/network`, `/socket.io` to `localhost:3000`. Uses its own `tsconfig.json` (ESNext modules, react-jsx) — does NOT extend `tsconfig.base.json`.

State managed via custom hooks (`useNetwork`, `useMessages`, `useMessageFlows`, `useSelectedNode`, `useNodeTypes`) that combine REST fetches + Socket.IO live updates.

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
