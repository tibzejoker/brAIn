# brAIn

**Bridged Reactive Artificial Intelligence Network**

```
  ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ██████╔╝██║  ██║██║  ██║██║██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
```

brAIn is an **orchestration framework for autonomous nodes** loosely
modeled after how the brain works. The codebase splits into:

- **The engine** (`packages/sdk`, `packages/core`, `packages/api`,
  `packages/dashboard`, `packages/agent`, `packages/python-sdk`):
  pub/sub bus (in-memory **or** distributed over NATS), two runners
  with criticality-aware scheduling, lifecycle hooks, a dynamic type
  registry, three transports (`process` / `web` / `remote`), a
  brain-agent daemon for cross-machine deployments, and a live
  dashboard.
- **A catalog of in-tree nodes** (`nodes/`): reasoning (LLM brain,
  developer, attention), memory (KV, vector, intelligent proxy,
  autonomous consolidator), and small tools (terminal, http-bridge,
  cron, etc.).
- **Sibling repos** for richer domains: perception
  ([brAIn-perception](https://github.com/tibzejoker/brAIn-perception)
  — voice / gaze / intent) and the curated public node
  [registry](https://github.com/tibzejoker/brAIn-store). Sibling
  checkouts are auto-detected; nothing else to configure.

Each node is an independent package that exports nothing but a
handler conforming to the SDK plus a `config.json`; the engine takes
care of the rest.

> See [ARCHITECTURE.md](./ARCHITECTURE.md) for the in-depth design
> (~1650 lines). This README is the operational tour.

---

## The engine

### Pub/sub bus

`packages/core/src/bus` — same `IBusService` interface in two flavours:

- **`BusService`** (in-process, default) — purely in-memory.
- **`NatsBusService`** — same interface backed by a NATS broker.
  Multiple brAIn processes (an API + N brain-agents on other hosts)
  share topics over the broker. Anti-loop on a per-instance origin id
  + native `request`/`reply` for synchronous read-back.

Common features regardless of backend:

- **Wildcard matching** on topics (`alerts.*` matches all depths,
  `voice.*` matches `voice.transcript`, `voice.speaker.detected`, etc.).
- **Per-subscription mailbox**: configurable `max_size` (default 100)
  and retention policy (`latest` or `lowest_priority`) — when the
  mailbox is full, either the freshest items are kept or the
  least-critical ones are dropped first.
- **Anti-loop**: a node never receives its own messages
  (`BusService.publish` skips the sender on routing).
- **Criticality** — numeric field on every message, plus
  `min_criticality` per subscription. Used for mailbox filtering and
  in-queue ordering. Mid-handler preemption based on criticality is
  scaffolded in the SDK (`PreemptionContext`) but **not yet
  implemented** in the runner — handlers run to completion for now.
- **Causal tracing** — every message carries `trace_id` + `parent_id`.
  Trace ids propagate through publishes and survive NATS encode/decode.
- **History** queryable via `GET /network/messages?last=N&topic=X`.

### Runners

`packages/core/src/runner` — every node runs inside a runner picked
based on its tags:

- **`ServiceRunner`** — for reactive non-LLM nodes (memory, http-bridge,
  terminal, voice/gaze handlers, …). Pattern: message arrives →
  handler called once → auto-sleep on `[any]`.
- **`LLMRunner`** — for LLM nodes (brain, analyst, memory-proxy).
  Pattern: message arrives → handler called in a **budget loop**
  (5 iterations by default). New messages **reset the budget** (fresh
  attention). When exhausted → forced sleep with configurable duration.
  The handler can `ctx.sleep()` voluntarily at any point.

### Transports

A node's `transport` decides where its handler actually runs:

- **`process`** — handler is a TS module loaded into the API process
  (default). Cheapest, used by every in-tree node.
- **`web`** — node is an external HTTP/WS service (any language). The
  framework opens a persistent WebSocket to it (`WebRunner`,
  reconnects + heartbeat) and bridges bus messages over the socket.
  Python helper SDK at `packages/python-sdk` (`brain-web`). Demo:
  `nodes/calc-py`.
- **`remote`** — node lives on another host inside a brain-agent.
  The API publishes a spawn-request on
  `brain.agents.<target_agent_id>.spawn`; the agent owns the runner
  locally; messages still flow on the shared NATS bus.

### Distributed runtime — brain-agent

`packages/agent` (`brain-agent` CLI binary) is a tiny daemon that
hosts nodes on a remote machine. It:

- Connects to the same NATS broker as the API (env: `BRAIN_NATS_URL`).
- Scans its local `nodes/` directory and registers types.
- Announces itself every 10 s on `brain.agents.discover`.
- Subscribes to `brain.agents.<self>.{spawn,kill,stop,start,wake}`
  and dispatches each request to its local `BrainService`. The API's
  lifecycle methods auto-route over NATS when the node is remote.
- Answers `brain.agents.<self>.read.{logs,mailboxes}` via NATS
  request-reply, so the dashboard's NodePanel works for remote nodes
  the same as local ones.

The dashboard's **Agents tab** lists every agent currently announcing.
The Node Creator's **Target** dropdown lets you pick "Local" or any
live agent for new spawns.

### Node lifecycle

Three optional hooks a node may export:

```typescript
export const onSpawn:  NodeOnSpawn  = (info) => { /* boot resources */ };
export const handler:  NodeHandler  = async (ctx) => { /* per-message */ };
export const teardown: NodeTeardown = async () => { /* release */ };
```

`onSpawn` runs once when the node is spawned (or restored from the
DB), `teardown` when it is killed/stopped. They let nodes manage
external resources (child processes, sockets, watchers) without
leaking.

### Anti-orphan child processes

`packages/core/src/child-server` + `nodes/voice/server/app/heartbeat.py`
+ `nodes/gaze/server/app/heartbeat.py` — guarantees **zero orphan
processes** when a node spawns an external binary (typically a Python
server):

- Node side: `startChildServer()` spawns with `BRAIN_PARENT_PID` in
  env, then `SIGTERM → grace period → SIGKILL` on teardown.
- Child side: a daemon thread polls `os.kill(BRAIN_PARENT_PID, 0)`
  every 2s. If the parent dies (Ctrl-C, crash, OOM, SIGKILL), the
  child cleanly self-terminates.
- If a server is already listening on the port (isolated debug run),
  the helper **attaches** to it instead of respawning — clean dev
  coexistence.

### Type registry + dynamic scanner

`packages/core/src/registry` — at boot, scans `nodes/` for valid
`config.json` files and registers the types. A **polling-based scanner
(`setInterval`)** on `nodes/_dynamic/` detects workspaces that
appear/disappear **at runtime** (the `developer` node drops generated
types there via the Claude / Codex / Gemini CLI agents).
**Workspace-hash-based validation**: hashes must remain stable for N
milliseconds before a type is committed, so we don't trigger reloads
while a file is mid-write.

### Persistence + restore

SQLite (`data/brain.db`) via `better-sqlite3`:

- Spawned nodes + their subscriptions + mailbox config + sleep state.
- History of actions (spawn/kill/seed/state-change).
- On restart: every live node comes back in the same state, sleep
  conditions included.

### Authority

Three levels (`BASIC=0`, `ELEVATED=1`, `ROOT=2`). Targeted actions
(kill, stop, rewire) require **strictly higher** authority than the
target. Prevents a basic node from killing the brain.

### Live dashboard

`packages/dashboard` — React 19 + React Flow + d3-force. Receives the
engine's events via Socket.IO:

- `node:spawned` — `NodeInfo`
- `node:killed` — `{ nodeId, reason }`
- `node:state_changed` — `{ nodeId, from, to }`
- `message:published` — `Message`

Five tabs in the side menu:

- **◉ Network** — live graph + selected-node panel (logs / mailbox /
  state actions). Remote nodes carry a `⚯ remote` badge and route
  control actions back through NATS.
- **◷ History** — chronological feed of network actions.
- **⚙ Seeds** — pre-baked YAML scenarios you can apply.
- **⊞ Store** — public registry browser (install in one click) plus a
  **Local candidates** section that surfaces dynamically-built node
  types from the developer node, with a "Copy registry entry" button
  to paste into a PR against `brAIn-store`.
- **⚯ Agents** — every brain-agent currently announcing on the bus
  (host, pid, uptime, registered types).

It also hosts **per-node UI panels** (see below).

### Per-node UI panels

If a node declares `"has_ui": true` in its `config.json` and ships a
`ui/index.html`, the dashboard exposes a dedicated panel (modal /
iframe) served by the API at `/nodes/:id/ui/`. Vanilla HTML, no build
step — the node UI talks straight to its own API (REST/WS) on its
port. See the gaze or intent UI for examples with live preview canvas,
faces panel CRUD, timeline, tuning sliders, etc.

---

## Node catalog

### Perception (sibling repo) — `voice` · `gaze` · `intent`

Lives in [brAIn-perception](https://github.com/tibzejoker/brAIn-perception),
checked out next to `brAIn/` and auto-detected at boot — `pnpm-workspace.yaml`
treats `../brAIn-perception/nodes/*` as workspace packages so the
`@brain/sdk` and `@brain/core` deps resolve normally. The API also
adds the path to its `bootstrap()` automatically.

Three independent nodes on the bus:

**`voice`** (`nodes/voice/`, ~180 lines TS + ~2200 Python)
Server-side mic capture (sounddevice), Silero VAD + faster-whisper STT
+ WeSpeaker speaker diarization. Maintains a SQLite `profiles` table
with rename / recolor / merge / extract-voiceprint operations. The TS
handler spawns the Python server as a child process, then bridges its
events onto the bus → `voice.transcript` (criticality 4 on finalized
segments), `voice.speaker.detected`. UI: device picker, canvas
timeline, live transcript, full speakers panel, tuning sliders (VAD
threshold, match, EMA decay, …).

**`gaze`** (`nodes/gaze/`, ~180 lines TS + ~7500 Python)
Server-side webcam capture (cv2.VideoCapture in a dedicated thread),
InsightFace for detection + recognition (ArcFace 512d), Gazelle
(DINOv2) for gaze direction, MediaPipe for iris signal, Moondream for
labeling whatever the gaze lands on when `describe=ON`. Pipeline split
into **2 threads**: a fast capture loop (always fresh) plus an
analysis worker (slow when describe is on). Server-side annotated
JPEG preview. The TS handler polls `/api/events` and republishes on
`gaze.target.resolved`. UI: live preview, faces panel CRUD/merge,
tuning sliders, describe toggle.

**`intent`** (`nodes/intent/`, ~840 lines pure TS, **zero Python**)
Correlator answering "who is talking to whom?". Subscribes to
`voice.transcript` + `gaze.target.resolved`, runs a sliding window
correlation by timecode (with state-freshness + lag adjustments),
publishes `intent.detected`. Local SQLite (`data/intent.db`) holds
`persons` (mapping `voice_profile_id ↔ gaze_profile_id ↔ canonical
name`) plus the intent history. A small embedded HTTP+WS server on
:8767 serves the UI (persons CRUD + live intents + proxy to
voice/gaze for the dropdowns).

### Reasoning — `brain` · `developer` · `attention`

**`brain`** (~780 lines) — the central consciousness. LLMRunner with a
step budget. Parses tool calls, executes tools (`publish_message`,
`spawn_node`, etc.), feeds the result back. Tool parser hardened for
small LLMs (trailing commas, single quotes, unquoted keys, markdown
fences, `tool`/`tool_name`/`args`/`arguments` aliases). The brain's
`message-formatter.ts` carries **static topic aliases** (`memory.store`
→ `mem.store`, etc.) to catch LLMs talking to the wrong service, plus
a dynamic discovery of `response_topic` from the live node list.
Conversational UI.

**`developer`** (~420 lines) — the agent that **creates new node types
on demand**. Delegates code generation to a CLI agent (Claude, Codex,
Gemini), validates via the type-validator, deploys under
`nodes/_dynamic/`. The dynamic scanner picks it up and registers it
without restarting the engine.

**`attention`** (~350 lines) — watches the bus and bridges "intents"
onto the topics the brain listens to, distinguishing direct addresses
(camera) from ambient context.

### Memory — `memory` · `memory-vector` · `memory-proxy` · `memory-consolidator`

**`memory`** (~230 lines) — fast KV store with tags. Word-split search
across keys / values / tags.

**`memory-vector`** (~270 lines) — LanceDB + Ollama embeddings
(`qwen3-embedding:0.6b`, 1024d). Cosine similarity, directory
indexing.

**`memory-proxy`** (~180 lines) — intelligent gateway. Receives natural
language on `mem.ask` / `mem.store`, reformulates, broadcasts to both
backends, synthesizes the answer with an LLM. **The brain should only
ever talk to the proxy**, never directly to the underlying stores.

**`memory-consolidator`** (~210 lines) — autonomous agent that
periodically reviews, merges duplicates, and cleans up stale entries.

### Tools — `terminal` · `http-bridge` · `reminder` · `cron` · `clock` · `echo` · `chat`

Small utilities (~10–150 lines each). `chat` is the human interface,
`clock` publishes the time, `cron` schedules on intervals,
`reminder` schedules one-shot alerts, `terminal` runs a whitelist of
shell commands, `http-bridge` proxies HTTP calls, `echo` is a debug
loop-back.

### LLM — `llm-basic` · `llm-cli`

Thin wrappers (~60 lines each) over LLM providers (Ollama, HTTP) and
CLI agents (Claude, Codex, Gemini). Used by other nodes via
`ctx.callLLM()`.

---

## Quickstart

### Prerequisites

- **Node.js** ≥ 20 (declared in `package.json`)
- **pnpm** (tested with 10.x; the workspaces work with pnpm 7+)
- **Python 3.11** (only for the voice / gaze nodes)
- **Ollama** (only for the local-LLM nodes: brain, memory-proxy,
  memory-consolidator, analyst — no model is bundled)

### Install

```bash
git clone git@github.com:tibzejoker/brAIn.git
cd brAIn
pnpm install
pnpm build
```

### Run the framework alone (API + dashboard, no nodes)

```bash
pnpm start
# API       → http://localhost:3000
# Dashboard → http://localhost:5173
```

### Pre-wired stacks

- `pnpm dev:voice` — API + dashboard + voice node (spawns uvicorn) + seed.
- `pnpm dev:gaze` — API + dashboard + gaze node (spawns uvicorn) + seed.
- `pnpm dev:intent` — API + dashboard + voice + gaze + intent + seed.
- `pnpm dev:vocal-chat` — same as `dev:intent` plus chat + brain (LLM).
- `pnpm start:attention` — API + dashboard + attention seed.

Every stack uses `concurrently --kill-others-on-fail --kill-signal SIGTERM`
so a single `Ctrl-C` propagates the teardown to every pane (API,
dashboard, tsc-watch, seed). Python child servers are reaped via their
parent-PID heartbeat (anti-orphan).

### Python setup

Each Python-backed node has its own venv and one-time model
downloads:

```bash
pnpm setup:voice      # venv + STT models (~200 MB)
pnpm setup:gaze       # venv + Gazelle + InsightFace + Moondream (~500 MB)
```

### Distributed runtime (NATS + brain-agent)

To run nodes on more than one machine:

```bash
# 1) On any machine — start a NATS broker
brew install nats-server          # or: docker run -p 4222:4222 nats
nats-server -p 4222

# 2) On the API host
BRAIN_NATS_URL=nats://<broker>:4222 pnpm start

# 3) On every worker host (Raspberry Pi, GPU box, ...)
BRAIN_NATS_URL=nats://<broker>:4222 \
  BRAIN_AGENT_NODES_DIR=$(pwd)/nodes \
  node packages/agent/dist/cli.js
```

The agent announces itself; the dashboard's **Agents** tab lists it.
Open the Node Creator and pick the agent in the **Target** dropdown
to spawn there — control + read-back all flow back through NATS.

Optional env vars: `BRAIN_NATS_PREFIX` (default `brain` — must match
on both sides), `BRAIN_NATS_TOKEN` (broker auth).

### Cleaning up orphans

If the stack falls over and a port stays held:

```bash
pnpm kill-orphans     # smart cleanup (by command line + ports)
pnpm kill-ports       # blunter — kills anything holding a known port
```

---

## REST API

### Nodes

```
GET    /nodes                  List instances
GET    /nodes/:id              Detail
POST   /nodes                  Spawn  { type, name, subscriptions?,
                                        transport?, target_agent_id? }
DELETE /nodes/:id              Kill (routes to agent if remote)
POST   /nodes/:id/stop         Stop (idem)
POST   /nodes/:id/start        Restart (idem)
POST   /nodes/:id/wake         Wake a sleeping node (idem)
POST   /nodes/:id/tick         Force one iteration (manual mode)
PATCH  /nodes/:id/config       Update config_overrides (null = delete a key)
GET    /nodes/:id/logs         Per-node log buffer (proxied via NATS for remote)
GET    /nodes/:id/mailboxes    Mailbox preview (idem)
```

### Types + dynamic

```
GET    /types                       List registered types
POST   /types/register              Register a type    { path }
DELETE /types/:name                 Unregister
GET    /network                     Full snapshot
GET    /network/messages            History  ?last=N&topic=X&min_criticality=N
POST   /network/seeds/:name/apply   Apply a YAML seed
```

### Store + agents (distributed runtime)

```
GET    /store/index             Raw registry from BRAIN_STORE_URL (cached 60s)
GET    /store/nodes             Registry decorated with installed/install_path
POST   /store/install            { package_name } — git-clone parent repo
GET    /store/candidates        Dynamic types ready to publish (developer)
GET    /agents                  Live brain-agents on the shared bus
```

### Node UI

```
GET    /nodes/:id/ui/          Serves nodes/<type>/ui/index.html (if has_ui)
POST   /nodes/:id/ui/send      Publish a message into the node
GET    /nodes/:id/ui/messages  Local conversation log
```

### WebSocket (Socket.IO)

Connect on `/socket.io`; events listed in the "Live dashboard" section
above.

---

## Authoring a node

Three minimum files under `nodes/<your-node>/`:

**`config.json`**
```json
{
  "name": "my-node",
  "description": "What this node does",
  "tags": ["utility"],
  "default_authority": 0,
  "default_priority": 1,
  "default_subscriptions": [{ "topic": "some.topic" }],
  "default_publishes": ["some.output"],
  "supports_transport": ["process"],
  "has_ui": false
}
```

`supports_transport` may include `"process"` (in-tree TS handler),
`"web"` (external HTTP/WS service — also requires a `web: { url }`
block), and/or `"remote"` (any node can be hosted on a brain-agent;
the agent dispatches it as `process` locally).

**`src/handler.ts`**
```typescript
import type { NodeHandler, NodeOnSpawn, NodeTeardown } from "@brain/sdk";

export const onSpawn: NodeOnSpawn = async (info) => {
  // boot external resources (child processes, sockets, …)
};

export const handler: NodeHandler = async (ctx) => {
  for (const msg of ctx.messages) {
    ctx.publish("some.output", {
      type: "text",
      criticality: 1,
      payload: { content: `Processed: ${JSON.stringify(msg.payload)}` },
    });
  }
  ctx.state.processed = (ctx.state.processed as number ?? 0) + ctx.messages.length;
};

export const teardown: NodeTeardown = async () => {
  // release whatever onSpawn acquired
};
```

**`package.json`**
```json
{
  "name": "@brain/node-my-node",
  "version": "0.1.0",
  "private": true,
  "main": "dist/handler.js",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@brain/sdk": "workspace:*",
    "@brain/core": "workspace:*"
  }
}
```

Then `pnpm install && pnpm build` — the type is auto-discovered on the
next engine boot (or immediately via the dynamic scanner if dropped
under `nodes/_dynamic/`).

---

## Tests

```bash
pnpm test                         # all vitest files (23)
npx vitest run tests/<single>.test.ts
```

Coverage: bus topic matching, registry, runner lifecycle (incl.
idempotent teardown + onSpawn), child-server spawn / SIGTERM / SIGKILL
escalation, memory handlers (KV + vector), HTTP bridge, message
formatter, brain conversation flows, end-to-end multi-node workflows,
budget exhaustion, …

Per-node Python tests live under `nodes/<x>/server/tests/` (heartbeat,
local_capture, etc.); run them with `.venv/bin/python -m unittest`.

---

## Tech stack

- `SDK` — TypeScript, types only.
- `Core` — TypeScript, pino, eventemitter3, better-sqlite3, uuid, ws,
  nats.js (distributed bus).
- `API` — NestJS 10, Socket.IO, express.
- `Agent` — TypeScript daemon (`packages/agent`), depends on core +
  sdk only. Ships a `brain-agent` CLI bin.
- `Dashboard` — React 19, React Flow, d3-force, Tailwind v4, Vite.
- `Bus` — in-memory by default; NATS when `BRAIN_NATS_URL` is set.
- `Persistence` — SQLite via better-sqlite3.
- `Monorepo` — pnpm workspaces (cross-repo via sibling paths to
  `../brAIn-perception/nodes/*`).
- `Python helper SDK` — `packages/python-sdk` (`brain-web`) for
  authoring `transport: "web"` nodes in Python.
- `Python servers` — FastAPI + uvicorn (perception nodes, sibling repo).
- `Tests` — vitest (TS), unittest (Python). NATS integration tests
  skip gracefully when `nats-server` isn't on PATH.
- `Lint` — ESLint strict (no `any`, no `console`, no `eslint-disable`, 300-line cap per file).

---

## Lint

ESLint is configured strictly:

- `no-explicit-any`, `no-console`, `noInlineConfig`
- `prefer-readonly`, `no-non-null-assertion`
- `consistent-type-imports` (`import type` mandatory)
- `react-hooks/exhaustive-deps`, `explicit-function-return-type`
- `eqeqeq`, `prefer-const`, `no-floating-promises`, `require-await`
- `max-lines: 300` per source file

Must pass `pnpm lint` with **zero errors and zero warnings**.

---

## License

[MIT](./LICENSE) — Copyright © 2026 Thibaut Léaux.
