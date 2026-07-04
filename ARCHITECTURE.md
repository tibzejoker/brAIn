# brAIn Architecture

**Bus-Reactive Ambient Intelligent Nodes.**
A runtime for autonomous agents that share a single pub/sub bus, react to many event streams in parallel, and can spawn or kill each other.

This document describes the **framework**: the engine, the contracts, and the mechanics that make the network tick. Specific node types (chat, brain, memory, perception, mobile, anything else) are *applications* of the framework and live in their own repos. They are not part of the architecture; they are what the architecture enables.

For commands and operational quirks see `AGENTS.md`; for a guided intro see `README.md`.

## 1 · Philosophy

Most agent frameworks model AI as a **request → response** function. brAIn models it as a **network of daemons watching a bus**.

- **The bus is the system.** Every participant (handlers, UIs, remote hosts) talks NATS. There is no central scheduler. There is no orchestrator. Coordination is emergent: a publisher emits on a topic, every subscriber reacts on its own clock.
- **Nodes are long-lived, not one-shot.** A handler is invoked when relevant messages arrive (or a `time.tick` fires), it does work, then the framework auto-parks the node until the next subscribed message lands. No idle CPU, no busy polling, no per-request cold start.
- **Preemption is first-class.** A higher-criticality message arriving during a slow operation aborts the in-flight handler via an `AbortSignal` and re-invokes it with `wasPreempted = true` plus the partial result. Latency-sensitive nodes don't have to choose between "long task" and "responsive."
- **No privileged code path.** The orchestrating LLM, the chat UI, the memory store, a mobile phone: they're all nodes with the same lifecycle, the same publish/subscribe surface, the same authority checks. The framework has no "blessed" node type.
- **Authority before features.** Every spawn / kill / start / stop crosses an `AuthorityService` check; a node can only manage children at strictly lower authority. Capability creep is bounded by construction, not by review.
- **Transport-agnostic by design.** The same handler signature runs in-process, behind a WebSocket, or as a remote NATS client. Whether the node lives in this process, a sibling laptop, or a phone is a config decision the handler never sees.
- **Author at runtime.** The framework hashes + watches a `_dynamic` directory. Drop a built node there and it registers without a restart; remove it and it unregisters cleanly.

If you remember nothing else: **publish to topics; return from your handler and the framework parks you; the bus wakes you when a subscribed message arrives.**

## 2 · Project structure

```
brAIn/
├── packages/
│   ├── sdk/             @brain/sdk        Pure types: NodeHandler, NodeContext, Message, Ports
│   ├── core/            @brain/core       Engine: BusService, BrokerService, Runners, Registries, Authority, Store
│   ├── api/             @brain/api        NestJS REST + Socket.IO gateway
│   ├── agent/           @brain/agent      brain-agent CLI, hosts nodes on a remote machine
│   ├── dashboard/       @brain/dashboard  React 19 + React Flow visualisation
│   └── python-sdk/      brain-web         Python helper for transport: "web" nodes
├── nodes/_dynamic/      author-at-runtime nodes (chokidar-watched)
├── seeds/               optional starter-network YAMLs (libraries ship their own; personal snapshots land in data/seeds)
├── scripts/brain.mjs    CLI for marketplace operations
└── data/                runtime state (see §5)
```

**Dependency flow:** `sdk` ← `core` ← `api` / `agent`. Dashboard imports `sdk` only. Node implementations import `sdk` only and never each other; they communicate exclusively through the bus.

Node *types* live outside this repo: any package matching `@brain/node-*` under `node_modules` or any subdirectory of a configured `nodesDir` (sister-repo globs by default) is auto-discovered by the type registry. The framework knows nothing of their domains.

## 3 · High-level system diagram

```
                            ┌──────────────────────────────────┐
                            │           NATS broker            │
                            │   (embedded by default · external│
                            │    via BRAIN_NATS_URL · LAN-bound│
                            │    via "Open to LAN")            │
                            └────────────┬─────────────────────┘
                                         │
            ┌────────────────────────────┼────────────────────────────┐
            │                            │                            │
   ┌────────▼────────┐         ┌─────────▼─────────┐         ┌────────▼─────────┐
   │   brAIn API     │         │   brain-agent     │         │  any NATS client │
   │   (this host)   │         │   (remote host)   │         │  (mobile, web,   │
   │                 │         │                   │         │   sidecar, …)    │
   │  ┌───────────┐  │         │  ┌─────────────┐  │         │                  │
   │  │ Runners   │  │         │  │ Runners     │  │         │  publishes /     │
   │  │ - process │  │         │  │ - process   │  │         │  subscribes      │
   │  │ - web ws  │  │         │  └─────────────┘  │         │  topics directly │
   │  │ - remote  │  │         │                   │         └──────────────────┘
   │  └───────────┘  │         │  Hosts node types │
   │                 │         │  the central API  │
   │  ┌───────────┐  │         │  asks for over    │
   │  │ Type      │  │         │  NATS req/reply.  │
   │  │ Registry  │  │         └───────────────────┘
   │  └───────────┘  │
   │                 │
   │  ┌───────────┐  │      ┌─────────────────────────────┐
   │  │ Authority │  │◄─────┤  Dashboard (React Flow)     │
   │  └───────────┘  │      │  REST + Socket.IO live feed │
   └─────────────────┘      └─────────────────────────────┘
```

A message published anywhere on the bus reaches every subscriber matching its topic, regardless of which process (or which machine) is hosting them.

## 4 · Core components

**`@brain/sdk`**: pure types, no runtime. `NodeHandler`, `NodeContext`, `Message`, `Subscription`, `PortsConfig`, `PortBindings`, `NodeOnSpawn`, `NodeTeardown`. The stable surface every other package depends on. Node authors import only this.

**`@brain/core`**: the engine.
- **`BrokerService`** spawns the bundled `nats-server` Go binary or attaches to `BRAIN_NATS_URL`. Owns the broker token, persists bind address.
- **`NatsBusService`** is the production bus. `BusService` (in-memory) exists only as a test fixture.
- **`Runners`** invoke handlers when subscriptions fire. Three flavours (`process`, `websocket`, `remote`) selected per-node by `transport`. Manage mailboxes, dormancy (auto-park on handler return), preemption via `AbortController`.
- **`TypeRegistry`** resolves `node config.json` files via two paths: directory scans (workspace-checkout layout) and `node_modules/@brain/node-*` package scans (installed-package layout). Both produce identical `NodeTypeConfig` records, and both enforce the mandatory ports contract (see §9).
- **`InstanceRegistry`** tracks live nodes (`NodeInfo` per id). Subscribed to by API + dashboard for the network view.
- **`AuthorityService`** gates every lifecycle call. Compares caller and target authority levels; throws on permission denial.
- **`StoreService`** mirrors the marketplace catalogue (`brAIn-store/registry.json`) and drives `pnpm brain pull` / `brain remove` (and the dashboard's install / uninstall).
- **`SkillStore`** owns the procedural-memory library (`SKILL.md` files, Agent-Skills frontmatter). The framework answers `skills.rpc.{search,load,save,delete,list}` over NATS request/reply, so any LLM node, local or on a remote agent, shares one library without local copies. Three tiers (user / lib-capability / node-scoped via `requires_node`); semantic retrieval via Ollama embeddings with a keyword fallback. See §9.
- **`DynamicTypeScanner`** chokidar-watches `nodes/_dynamic/*` and `passiveDirs`, hashes config + handler artifacts, registers / unregisters types as they appear, change, or disappear.
- **`startChildServer`** is a generic supervisor for nodes that wrap a sidecar process (Python uvicorn, native binary, …). Health-check + cold-start timeout + crash recovery are not re-implemented per node.

**`@brain/api`**: NestJS gateway. REST endpoints for spawn / kill / seed / port-binding / network introspection / config patches. Socket.IO push for live bus events to the dashboard. Routes per-node UIs from `<typeDir>/ui/` under `/nodes/:id/ui/*`, plus a generic `/send` to drive a node's own subscriptions from its UI (uses an injected `from` to bypass anti-loop).

**`@brain/agent`**: standalone CLI. Joins an external NATS broker, advertises which node types it can host, accepts spawn/kill/start/stop over NATS request/reply. Same `NodeHandler` contract as in-process; the framework's runner abstraction is the only thing that differs. No privileged access: every action it takes also crosses the same authority check on the central API.

**`@brain/dashboard`**: React 19 + React Flow + Tailwind v4. Network graph (live), distributed pane (broker + remote agents + LAN QR), bus event monitor, store browser, per-node UI iframes. Imports `@brain/sdk` only; it's a normal NATS-aware client.

**`@brain/python-sdk` / `brain-web`**: Python wrapper for nodes that speak the bus over WebSocket. Same `NodeContext` surface, ported. For services that can't import the TS SDK (Python ML servers, external apps).

## 5 · Data stores

| Store | Used by | Holds |
|---|---|---|
| `data/brain.db` (SQLite) | core | Node configs, subscriptions, mailbox snapshots, broker token, kv settings (no dormancy state; the runtime is reactive, nodes re-subscribe and idle on boot) |
| `data/skills/<name>/SKILL.md` | core (`SkillStore`) | Personal/user skills, writable by LLM nodes + the dashboard; lib-bundled skills are read-only and live in each lib's `skills/` dir |
| `data/agent.db` (SQLite) | brain-agent | Per-agent join state when attached to a remote broker |
| `data/broker.json` | broker | Bind address (loopback vs LAN) |
| `data/nodes/<id>/` | every node | Reserved per-node `ctx.dataDir` for arbitrary persistent files (DBs, blobs, logs) |
| `data/seeds/*.yaml` | core | Personal seed snapshots saved from the dashboard ("Save current") |

Each node owns its `dataDir` exclusively. Cross-node data **must** flow on the bus, not by reaching into another node's directory. Anything a node persists outside `dataDir` is bypassing the framework.

## 6 · Integration patterns

The framework is deliberately small. Most "integrations" are recurring patterns nodes use, not bespoke pieces of the engine.

- **Bus-first transport**: every external system enters the network as topics. A new integration writes a node that translates the foreign protocol into messages.
- **Sidecar pattern (`startChildServer`)**: a node that needs heavy native deps (ML models, native libs, alternate runtimes) spawns its own child process and bridges I/O onto the bus. The framework supervises lifecycle; the child stays opaque.
- **Web transport**: nodes that can't run TS in-process talk to the API over WebSocket using `transport: "web"`. The runner translates the WS frames into the same `NodeContext` calls as in-process handlers.
- **Remote transport**: `brain-agent` (or any custom NATS client) hosts nodes on a different machine. Lifecycle commands are routed over NATS request/reply; published messages flow normally.
- **Marketplace + sister-repo split**: a node bundle lives in its own git repo, registers in `brAIn-store/registry.json`, gets cloned on demand by `pnpm brain pull`, and joins the workspace via pnpm sibling globs. The framework neither knows nor cares which domain bundle is checked out.

## 7 · Deployment & infrastructure

- **Single host (default)**: `pnpm start` runs API + Dashboard with the embedded NATS broker on `127.0.0.1`.
- **LAN cluster**: the "Open to LAN" toggle in the dashboard rebinds the broker to `0.0.0.0`, surfaces the auth token + reachable IP, and renders a `brain://join?url=&token=` QR for one-tap pairing of any NATS-aware client.
- **External broker**: `BRAIN_NATS_URL` skips the embedded broker entirely.
- **Dev supervisor**: `packages/api/scripts/dev-supervisor.mjs` wraps `tsc -w` + a node child, respawning on clean exit. Required because rebind/token-rotation endpoints intentionally `process.exit(0)` to relaunch with the new config.
- **Tests**: vitest with a global setup that brings up one nats-server per session. Handler tests mock `NodeContext`; integration tests use the real NATS embedded. Coverage via `@vitest/coverage-v8` → `coverage/lcov.info`.
- **Lint policy**: `pnpm lint` must pass with **0 errors and 0 warnings**. `eslint-plugin-sonarjs` enforces anti-patterns + a cognitive-complexity ratchet (baseline 60).
- **CI**: GitHub Actions per repo: `ci` (lint + framework tests + per-node tests), `gitleaks`, `trufflehog`, `release-please`. Branch protection requires all four; auto-merge enabled per-PR. Dependabot wired in.
- **Versioning**: Release Please derives tags + GitHub releases from Conventional Commits (`feat:` / `fix:` / `!` / `BREAKING CHANGE:`). brAIn-mobile additionally builds + attaches an APK. Packages are consumed as workspace members (not published to npm).
- **Deep static analysis**: local `docker-compose.ci.yml` runs SonarQube CE; SonarCloud auto-analysis covers PRs on tibzejoker.

## 8 · Security model

- **Authority levels**: `ROOT` (2) > `ELEVATED` (1) > `BASIC` (0). Spawning a child caps the child at one level below the caller (a ROOT node spawns at most ELEVATED). `kill` / `stop` / rewire requires the target to be strictly below the caller. Defined in `core/authority`, enforced in every lifecycle path.
- **Broker auth**: single shared token, persisted in `kv_settings.broker_token`, rotatable from the dashboard. Enforced by the embedded `nats-server` via `--auth`. Remote clients pass it via `BRAIN_NATS_TOKEN` or the QR join URI.
- **Bind scope**: default `127.0.0.1`. LAN exposure is opt-in and surfaced explicitly in the UI.
- **Anti-loop**: a node never receives messages it itself published. Synthetic origins (`system.api`, `system.ui`, …) bypass anti-loop so framework-level publishes can drive a node's own subscriptions without circular delivery.
- **Per-node data isolation**: `ctx.dataDir` is the contract; nodes don't share filesystems.
- **Node UIs**: served read-only from each type's `ui/` directory through `/nodes/:id/ui/*`; any message a UI publishes goes through the same authority-checked publish path as anywhere else.

## 9 · Runtime mechanics

A few things worth understanding before reading the source.

- **Runner loop**: the runner registers per-subscription consumers on the bus. When a message lands matching a node's subscription, it goes into that node's mailbox and the runner invokes the handler. A handler returning yields control and the node parks automatically until the next subscribed message arrives. There is no manual sleep API; periodic work subscribes to `time.tick` from the always-running `clock` node (or a `cron` instance for custom cadences from `ms` to `y`).
- **2-layer wiring**: a node's `config.json` declares **ports** (named, typed inputs/outputs, the immutable contract, each input surfaced as an MCP tool) plus `default_port_bindings` mapping every port to the bus topics it listens on or emits to. The runner expands ports + bindings into the flat subscriptions it registers, and bindings are re-wirable at runtime (`POST` / `DELETE /nodes/:id/ports/:side/:port/topics`) without redeploying the node. Ports are mandatory: a config without them is rejected at registration, and the flat `default_subscriptions` / `default_publishes` lists are derived from them, never hand-written.
- **Mailbox**: bounded per (node, topic) with a retention policy: `latest` (drop oldest) or `lowest_priority` (drop the smallest-criticality message first). Anti-flood without dropping importance.
- **Preemption**: when a higher-criticality message lands while a handler is mid-flight, the runner aborts `ctx.signal`. Long-running operations (LLM calls, fetch, child-process I/O) are expected to honour the signal. The next handler invocation gets `wasPreempted = true` plus the partial result in `ctx.preemptionContext`.
- **Spawn / restore**: spawned nodes are persisted in `brain.db`. On API boot, the registry replays them; their `onSpawn` hook runs again as if they were freshly created. Crash recovery is the same code path as cold start.
- **Trace IDs**: every published message carries a `trace_id`. Replies and forwards inherit it; the API exposes `GET /network/traces/:id` to walk the chain. Useful for debugging emergent flows.
- **Skills retrieval**: `ctx.skills` is a thin facade over `skills.rpc.*` NATS request/reply, so the framework (never the node) holds the library, one copy shared by every LLM node including remote agents. A query is embedded (Ollama `qwen3-embedding:0.6b`, cosine over a content-versioned cache) and ranked, with keyword overlap as the fallback when embeddings are unavailable. The node catalog is filtered by live instance types so `requires_node` skills appear only when their node is spawned. The brain auto-injects the single best match's body and lists the rest; it can `load_skill` for others. Auto-injection (rather than relying on the model to call a tool) is what makes skills land on small models like `gemma4:e4b`.

## 10 · Future considerations

- **Distributed authority audit log**: authority decisions are local; making them traceable across `brain-agent`s would let security reviews follow a remote spawn chain end-to-end.
- **Generic secrets management**: per-node `secrets:` block in seeds, env injection at spawn, rotation surface in the dashboard. Today secrets are ad-hoc per node.
- **Bus replay**: today the bus is fire-and-forget. A bounded JetStream-backed replay window would let restarted nodes catch up on what they missed during downtime instead of having to be retold.
- **Stronger transport pluggability**: `process` / `web` / `remote` are coded into the runner; an interface-driven version would let users define new transports (e.g. embedded native bindings) without core changes.

## 11 · Project identification

- **Name:** brAIn (Bus-Reactive Ambient Intelligent Nodes)
- **Repository:** [tibzejoker/brAIn](https://github.com/tibzejoker/brAIn)
- **License:** MIT
- **Last updated:** 2026-06-01

Domain-specific node bundles live in sibling repos under the same owner and are documented in `README.md`; they are users of this architecture, not parts of it.

## 12 · Glossary

| Term | Meaning |
|---|---|
| **Node** | Long-lived autonomous unit with subscriptions, a mailbox, and a handler. |
| **Bus** | NATS pub/sub. The only inter-node communication channel. |
| **Topic** | NATS subject string. Publishers emit on one; subscribers match by exact or wildcard. |
| **Port** | A named, typed input or output a node declares. Inputs become callable MCP tools; bindings map ports to bus topics. The immutable wiring contract. |
| **Binding** | The mutable map from a node's ports to the bus topics they currently listen on or emit to. Re-wirable at runtime. |
| **Mailbox** | Bounded queue of unread messages per (node, topic) with a retention policy. |
| **Dormancy** | A node's parked state between handler invocations. Auto-entered when the handler returns, auto-exited when the bus delivers a subscribed message. No manual sleep/wake API. |
| **Criticality** | 0–10 priority on a message. Drives mailbox eviction and runtime preemption. |
| **Preemption** | When a higher-criticality message arrives during a handler's slow operation, the runner aborts `ctx.signal` and re-invokes with `wasPreempted = true`. |
| **Authority** | Capability level (`ROOT` = 2 > `ELEVATED` = 1 > `BASIC` = 0) gating spawn / kill / start / stop. |
| **Type** | Node template defined by `config.json` + `dist/handler.js`. Registered statically, dynamically, or as an installed `@brain/node-*` package. |
| **Instance** | A running node with an `id`, derived from a type at spawn time. |
| **Transport** | How a node's handler is reached from the runner: `process`, `websocket`, `remote`. |
| **Seed** | YAML declaring a starter network: types to install, instances to spawn, and the config_overrides (including port bindings) each gets. |
| **Dynamic node** | A node authored at runtime under `nodes/_dynamic/`, picked up by the chokidar scanner without a restart. |
| **Marketplace** | `brAIn-store/registry.json`: the catalogue of installable node packages, hashes, and source repos. |
