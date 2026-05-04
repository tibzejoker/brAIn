# brAIn

**Bus-Reactive Ambient Intelligent Nodes**

```
  ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ██████╔╝██║  ██║██║  ██║██║██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
```

A runtime for autonomous agents that live in a **many-to-many event
world**.

Nodes are long-lived daemons. Each one subscribes to several input
streams (chat messages, sensor events, webhooks, internal bus
traffic, anything you can publish), reacts when something relevant
shows up, and can publish to as many outputs in parallel. There's no
single triggering channel: the agent watches and decides when to
act.

A node may also be preempted mid-flight: when a higher-criticality
message lands during a slow operation (an LLM call, a tool
invocation, a CLI agent), the runner aborts what's in progress and
re-runs the handler with the new context surfaced in
`ctx.preemptionContext`. Same node config can run in-process, behind
a WebSocket, or on a remote `brain-agent` joined to a shared NATS
bus.

> [ARCHITECTURE.md](./ARCHITECTURE.md) for the long-form design. This
> README is the operational tour.

---

## Concretely

A few shapes you can build with this:

- An **ambient room agent** that watches camera + mic and only
  speaks when someone is looking at it while talking — the flagship
  demo (voice + gaze + intent + brain).
- A **Slack-channel listener** that lives in a thread, picks up
  context across messages, and summarises or replies when the
  conversation pauses.
- A **monitoring agent** subscribed to Grafana alerts +
  oncall-rotation events + recent deploys, that surfaces a
  hypothesis when a correlation crosses a threshold.
- An **IoT controller** that fuses temperature, motion, calendar,
  and time-of-day to decide when to change the environment.

The framework's primitives:

- **Daemon model** — nodes live across iterations, sleep when idle,
  wake on events. State persists across runs.
- **Many-to-many I/O** — each node subscribes to N topic patterns
  (with wildcards) and publishes to as many.
- **Criticality with preemption** — every message carries a
  criticality. A higher-criticality message arriving mid-handler
  aborts the running iteration and triggers a re-run with
  `ctx.preemptionContext.{interrupting_message, previous_messages}`
  available.
- **Distributed runtime** — same node config runs in-process or on
  a remote `brain-agent`. Lifecycle (stop / start / wake) and
  read-back (logs / mailbox / DLQ) work transparently across
  machines over NATS.
- **MCP-native** — `mcp-config` (manager) + `mcp-server` (one per
  upstream) bridge any MCP server's tools onto the bus, so the
  agent reaches into filesystem, git, Slack, Linear, Notion,
  Sentry … as it would call any other node.

---

## Engine

### Bus + mailboxes

`packages/core/src/bus` — `NatsBusService` implements `IBusService`
on top of a NATS broker. The framework boots an embedded
`nats-server` (the bundled Go binary, downloaded by the postinstall
hook) on a free localhost port; remote `brain-agent` processes
connect to that same broker and share the bus. Set
`BRAIN_NATS_URL` to skip the embedded broker and join an external
one instead — typical when running across multiple hosts.

`BusService` (in-memory) is still exported but only as a test
fixture — production code path always goes through NATS.

Features:

- Wildcard topic matching (`alerts.*`).
- Per-subscription **mailbox** with configurable `max_size` and a
  `latest` / `lowest_priority` retention policy. `dropped` and
  `capacity` are exposed so the dashboard can show per-mailbox
  backpressure.
- **Causal traces**: every message carries `trace_id` + `parent_id`.
  Survives NATS encode/decode, queryable via
  `GET /network/traces/:id`. Each trace can be **replayed** as fresh
  emissions through `POST /network/traces/:id/replay` — fresh ids,
  rewritten parent chain, original `trace_id` carried as
  `metadata.replayed_from` for debugging.
- **History** sliding window (10k messages by default).

### Runners

`packages/core/src/runner` — picked from a node's tags:

- **`ServiceRunner`** for reactive non-LLM nodes (memory, http-bridge,
  terminal, …): message arrives → handler called once → auto-sleep on
  `[any]`.
- **`LLMRunner`** for LLM nodes (brain, memory-proxy,
  memory-consolidator): handler called in a budget loop (default 5
  iterations). New messages **reset the budget** (fresh attention).
  When exhausted → forced sleep.

### Preemption

When a higher-criticality message lands while a handler is running,
the runner aborts the iteration instead of waiting it out.

`ctx.signal` is an `AbortSignal` exposed to every handler. LLM
handlers pass it to `generateText({ abortSignal: ctx.signal })`, CLI
nodes to `spawn(..., { signal })`, MCP nodes to
`client.callTool(..., { signal })`. The abort propagates through to
the underlying HTTP request, so a long inference at the LLM provider
or a long subprocess invocation gets cut at the source — not just
queue-reordered between iterations.

The threshold (how much higher the incoming criticality must be) is
configurable; default is 3. The next handler invocation runs with
`ctx.wasPreempted = true` and the preemption details in
`ctx.preemptionContext`.

### Distributed runtime — `brain-agent`

`packages/agent` ships a `brain-agent` CLI binary that joins the
shared NATS bus and hosts nodes on a remote machine. It announces
itself every 10 s, subscribes to its control topics
(`brain.agents.<self>.{spawn,kill,stop,start,wake}`), and answers
read-back requests for `logs / mailboxes / dead_letters` via NATS
request-reply. The dashboard's **Agents** tab lists every live agent
and the Node Creator's **Target** dropdown lets you pick "Local" or
any agent for a new spawn. When an agent stops announcing past
~30 s, its remote-node stubs are automatically pruned from the API.

### MCP — `mcp-config` + `mcp-server`

Lives in [brAIn-essentials](https://github.com/tibzejoker/brAIn-essentials).
`mcp-config` owns a single Claude-Desktop-shaped JSON
(`{mcpServers: {...}}`) and reconciles it by spawning / killing
`mcp-server` children — one per upstream. Each `mcp-server` connects
via the official `@modelcontextprotocol/sdk` and exposes each tool
as its own bus topic `mcp.<alias>.<tool>`, so callers wire to
capabilities directly. Status, OAuth state and tool catalog are on
`mcp.<alias>.{status,tools,oauth.required}`. Four transports
supported per upstream: `stdio`, `http` (Streamable HTTP), `sse`,
`ws`. `ctx.signal` propagates → preemption kills MCP calls in
flight.

### Observability

- **DLQ**: every message in flight when a handler crashes / times
  out is captured in a per-runner ring (50 entries). Surfaced under
  the NodePanel's DLQ tab; the tab badge flips red on first entry.
- **Backpressure**: each mailbox tracks `dropped` (cumulative
  evictions) and `capacity`. The Mailbox tab shows a fill bar
  coloured by load.
- **Tracing**: any message in the history can be opened as a tree in
  the dashboard, with one-click replay.

### Persistence

SQLite (`data/brain.db`) via `better-sqlite3`. Spawned nodes,
subscriptions, mailbox config, and sleep state all survive restarts.

### Authoring a node

Three minimum files under `nodes/<your-node>/`:

```jsonc
// config.json
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

```typescript
// src/handler.ts
import type { NodeHandler, NodeOnSpawn, NodeTeardown } from "@brain/sdk";

export const onSpawn: NodeOnSpawn = async (info) => {
  // boot external resources (child processes, sockets, …)
};

export const handler: NodeHandler = async (ctx) => {
  for (const msg of ctx.messages) {
    ctx.publish("some.output", {
      type: "text",
      criticality: 1,
      payload: { content: `Got: ${JSON.stringify(msg.payload)}` },
    });
  }
  // Pass ctx.signal to anything long-running so the runner can
  // preempt this iteration when an urgent message lands.
};

export const teardown: NodeTeardown = async () => {
  // release whatever onSpawn acquired
};
```

`supports_transport` may include `"process"` (in-tree TS handler),
`"web"` (external HTTP/WS service — also requires a `web: { url }`
block), and/or `"remote"` (any node hosted on a brain-agent).

The type is auto-discovered on engine boot, or registered live via
the dynamic scanner if dropped under `nodes/_dynamic/`.

---

## Nodes

This repo ships zero nodes — `nodes/` only contains a `_dynamic/`
slot for the runtime scanner. Every capability comes from a sister
repo, installed via the in-app Marketplace tab (backed by
[brAIn-store](https://github.com/tibzejoker/brAIn-store)).

- [**brAIn-essentials**](https://github.com/tibzejoker/brAIn-essentials)
  — `brain` (LLM orchestrator with a tolerant tool-call parser),
  `developer` (writes new node types at runtime via Claude / Codex
  / Gemini CLIs), `attention`, `clock`, `cron`, `echo`, `mcp-config`
  + `mcp-server`.
- [**brAIn-memory**](https://github.com/tibzejoker/brAIn-memory) —
  `memory` (KV + tags), `memory-vector` (LanceDB + Ollama
  embeddings), `memory-proxy` (LLM-mediated gateway — the brain
  talks here, never to the underlying stores),
  `memory-consolidator`, `reminder`.
- [**brAIn-tools**](https://github.com/tibzejoker/brAIn-tools) —
  `terminal`, `http-bridge`, `calc-py` (Python node behind a
  WebSocket, demonstrates `transport: "web"`).
- [**brAIn-llm**](https://github.com/tibzejoker/brAIn-llm) —
  `llm-basic` (Vercel AI SDK wrapper), `llm-cli` (Claude Code /
  Codex / Gemini wrapper).
- [**brAIn-ui**](https://github.com/tibzejoker/brAIn-ui) — `chat`
  (browser interface for human ↔ network).
- [**brAIn-perception**](https://github.com/tibzejoker/brAIn-perception)
  — `voice` (faster-whisper + WeSpeaker), `gaze` (InsightFace +
  Gazelle + Moondream), `intent` (voice × gaze correlator).

### Showcase: ambient perception

`voice` publishes `voice.transcript`, `gaze` publishes
`gaze.target.resolved`, `intent` matches them on a sliding window
and emits `intent.detected` when the same person is seen looking at
the camera while talking. Combined with `brain` and `chat`, the
room agent responds without a wake word or a chat-box input. The
voice and gaze servers auto-install their virtualenv and download
the ML weights on first spawn.

---

## Quickstart

### Prerequisites

- **Node.js** ≥ 20, **pnpm** 7+
- **Ollama** for local LLM nodes (`ollama pull gemma3:4b`,
  `ollama pull qwen3-embedding:0.6b`)
- **NATS** is included — `pnpm install` fetches the bundled
  `nats-server` Go binary. To use a broker you already run, set
  `BRAIN_NATS_URL` and the framework skips the download.
- **Python 3.11** only if you check out
  [brAIn-perception](https://github.com/tibzejoker/brAIn-perception)

### Run the framework alone

```bash
pnpm install            # postinstall: builds sdk + core, clones
                        # brAIn-store, downloads nats-server binary
pnpm start
# API       → http://localhost:3000
# Dashboard → http://localhost:5173
```

The framework boots empty (zero nodes) and spawns an embedded
`nats-server` on a free localhost port.

```bash
pnpm brain list             # marketplace registry — installed + available
pnpm brain pull memory      # install one by name
```

Or open the dashboard's **Marketplace** tab to install seed bundles
or individual nodes
from the sister repos, or apply a YAML seed from `seeds/` (`default`,
`chat`, `vocal-chat`, `demo-memory`, `demo-needs`).

### Pre-wired stacks (require sibling clones)

When the relevant sister repo is cloned alongside `brAIn/`,
`pnpm-workspace.yaml` picks it up automatically:

```bash
pnpm dev:voice          # voice + seed
pnpm dev:gaze           # gaze + seed
pnpm dev:intent         # voice + gaze + intent
pnpm dev:vocal-chat     # the full ambient stack
```

### Hosting nodes on another machine

On the API host, open the Distributed tab and click **Open to LAN**
once. That binds the embedded broker on `0.0.0.0` and pins an auth
token. The panel shows a one-liner snippet — copy it.

On the target machine:

```bash
git clone https://github.com/tibzejoker/brAIn && cd brAIn
pnpm install
pnpm brain pull memory          # (or whichever nodes the agent should host)
# paste the snippet from the Distributed tab:
BRAIN_NATS_URL=nats://<api-lan-ip>:<port> BRAIN_NATS_TOKEN=<token> npx brain-agent
```

The agent shows up in the Distributed tab. From the Node Creator,
pick it as **Target** to spawn nodes on it.

Pin the broker port across restarts with `BRAIN_BROKER_PORT=4222`.
Run an external broker with `BRAIN_NATS_URL=nats://<host>:<port>` —
the API skips the embedded one and joins yours.

### Cleanup

```bash
pnpm kill-orphans       # smart cleanup by cmdline + ports
pnpm kill-ports         # blunter
```

---

## REST API

```
# Nodes
GET    /nodes                  List
GET    /nodes/:id              Detail
POST   /nodes                  Spawn  { type, name, transport?,
                                        target_agent_id?, … }
DELETE /nodes/:id              Kill
POST   /nodes/:id/{stop,start,wake,tick}
PATCH  /nodes/:id/config       Update config_overrides
PATCH  /nodes/:id/position     Persist dashboard layout
GET    /nodes/:id/{logs,mailboxes,dead-letters}

# Types
GET    /types
POST   /types/register   { path }
DELETE /types/:name

# Network + traces
GET    /network                          Full snapshot
GET    /network/messages                 History
GET    /network/history                  Lifecycle audit log
GET    /network/transport                { nats, url? }
GET    /network/{providers,devmode}
POST   /network/{devmode,tick,reset}
GET    /network/traces/:trace_id         Walk a causal chain
POST   /network/traces/:trace_id/replay  Re-publish as fresh emissions
GET    /network/seeds                    List available YAML seeds
POST   /network/seeds/:name/apply        Apply a seed (?merge=true to add)

# Store (marketplace)
GET    /store/{index,nodes,candidates,upstream-status,installed-updates}
POST   /store/install            { package_name }
POST   /store/refresh            Pull brAIn-store

# Agents (distributed)
GET    /agents

# Node UI
GET    /nodes/:id/ui/            Static node UI
POST   /nodes/:id/ui/send        Publish into the node
GET    /nodes/:id/ui/messages    Conversation log

# MCP OAuth callback
GET    /mcp/oauth/callback
```

WebSocket events on `/socket.io`: `node:spawned`, `node:killed`,
`node:state_changed`, `message:published`.

---

## How brAIn relates to other tools

brAIn isn't a competitor to most of the agentic tools you may know;
they solve adjacent problems and the right one depends on the shape
of the agent you want.

**LangGraph / Vercel AI SDK / Mastra** — for chat-shaped agents
(user types → LLM thinks → tools → LLM responds), these are
excellent and deeper than brAIn's chat support. Reach for them when
the agent is fundamentally a conversational interface.

**AutoGen / CrewAI** — multi-agent conversations with roles. Use
these when you want several LLM personas debating or collaborating
within a single dialogue.

**ROS 2** — the closest architectural cousin. Pub/sub bus, daemon
nodes, multi-language, cross-machine over DDS. brAIn shares a lot
of its mental model with ROS. The differences are domain-specific:
brAIn is built around LLM constraints (token budgets, abortable
inference, tool-call loops, MCP), runs over NATS rather than DDS
(easier to deploy when you don't need real-time guarantees), and
preempts at the work-in-progress level rather than between
callbacks.

**Inngest / Trigger.dev / Temporal** — durable workflows. If your
agent is a finite-shape DAG with retries and backoff, those are
production-grade options. brAIn's nodes are open-ended daemons;
the two run on different mental models.

**n8n / Flowise / Langflow / Dify / Node-RED** — visual
node-based authoring. brAIn nodes are written in code (a
TypeScript handler plus a `config.json`, or any HTTP/WS service
via `transport: "web"`). The dashboard is observation-first.

**Claude Cowork / OpenAI scheduled tasks / cron-driven agents** —
time-triggered prompts. brAIn is event-triggered; if your agent's
cadence is "every Monday morning summarise X", a scheduler is the
right primitive.

A condensed comparison of the architectural traits brAIn happens to
have, for context:

| | brAIn | LangGraph | AutoGen | ROS 2 |
|---|---|---|---|---|
| Long-lived daemon nodes | yes | graph runs per call | per conversation | yes |
| Many-to-many bus | yes | inputs flow through the graph | conversation channel | yes |
| Mid-handler abort on priority | yes (LLM/CLI/MCP signal-aware) | — | — | priorities at the queue level |
| LLM-native primitives | yes | yes | yes | — |
| Cross-machine | NATS | — | — | DDS |
| MCP client | yes (4 transports) | per-tool wrappers | per-tool wrappers | — |
| Causal trace + replay | yes (`/network/traces/:id/replay`) | LangSmith captures traces | — | — |

---

## Tech stack

- **SDK** — TypeScript, types-only package consumed by every node.
- **Core** — TypeScript engine: pino, eventemitter3, better-sqlite3,
  ws, nats.js, ai (Vercel SDK), `@modelcontextprotocol/sdk`.
- **API** — NestJS 10 + Socket.IO + express.
- **Agent** — `brain-agent` CLI binary (`packages/agent`) for
  remote-host node execution over the shared bus.
- **Dashboard** — React 19, React Flow, d3-force, Tailwind v4, Vite.
- **Bus** — in-memory by default; NATS when `BRAIN_NATS_URL` is set.
- **Persistence** — SQLite via better-sqlite3.
- **Monorepo** — pnpm workspaces, with cross-repo sibling
  resolution to `../brAIn-{essentials,memory,tools,llm,ui,perception}/nodes/*`
  when those companion repos are checked out. Missing paths are
  silently ignored.
- **Marketplace** — `../brAIn-store` is auto-cloned by the
  postinstall hook; the dashboard's Marketplace tab installs nodes
  and seeds from it (SHA-pinned, per-file checksums).
- **Cross-language nodes** — `packages/python-sdk` (`brain-web`)
  helper for nodes that speak the bus from Python over WebSocket
  (`transport: "web"`).
- **Tests** — vitest, with optional integration suites that gate on
  the relevant dependency being available (NATS, Ollama, MCP servers).

---

## Tests

```bash
pnpm test                                    # all
RUN_LLM_E2E=1 npx vitest run tests/preemption-llm-e2e.test.ts
RUN_MCP_E2E=1 npx vitest run tests/mcp-host-public-server-e2e.test.ts
```

Around 30 vitest files. Areas covered:

- **Engine** — bus routing and topic matching, mailbox + backpressure,
  registries, dynamic-scanner, type validation, tool-call parsing,
  message formatter.
- **Runners** — lifecycle, idempotent teardown + onSpawn, handler
  crash recovery, dead-letter capture, timeouts, preemption (unit +
  E2E with a real Ollama call).
- **Distributed** — NATS bus routing and anti-loop, real
  `nats-server` integration, agent announcements + cleanup,
  remote-spawn full cycle.
- **MCP** — in-process fixture plus an E2E against the published
  `@modelcontextprotocol/server-filesystem`.
- **Memory + brain** — secret retrieval, multi-service workflows,
  consolidator, LLM budget exhaustion.
- **Subprocess hygiene** — child-server SIGTERM → SIGKILL
  escalation; HTTP bridge.

---

## Lint

`pnpm lint` runs ESLint over the whole monorepo. The configuration
is on the strict end of TypeScript style: no `any`, no `console`,
mandatory `import type`, explicit return types, no inline
`eslint-disable`, and a 300-line cap per source file. Contributions
need to land at zero errors and zero warnings.

---

## License

[MIT](./LICENSE) — Copyright © 2026 Thibaut Léaux.
