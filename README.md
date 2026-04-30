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

A runtime for autonomous agents in a **many-to-many event world**.

Today's agentic frameworks are wired for chat (`request → response`)
or cron (timed prompts). brAIn flips it: nodes are long-lived daemons
that subscribe to multiple input streams and react when **relevance**
— not a chat message, not a clock — says they should. They can fan
out to many outputs in parallel, get **preempted** by higher-criticality
events mid-flight, and live across machines on a shared bus.

> [ARCHITECTURE.md](./ARCHITECTURE.md) for the long-form design. This
> README is the operational tour.

---

## Why this exists

| Existing pattern | What's wrong for ambient agents |
|---|---|
| **Chat-driven** (LangGraph, AutoGen) — one input, one response, request/response | Nothing happens until a human types. The agent can't notice. |
| **Cron-driven** (Claude Cowork scheduled, OpenAI scheduled tasks) — timed prompts | Reacts to the clock, not to the world. Wakes whether or not anything's worth saying. |
| **Tool-calling agents** — single conversation, tools fan out from there | Still one input channel, still synchronous, still no preemption. |

brAIn's primitives go the other way:

- **Daemon model**: nodes live across iterations, sleep when idle,
  wake on events. State persists, no re-bootstrap each call.
- **Many-to-many I/O**: every node subscribes to N topic patterns
  (with wildcards) and publishes to as many. Voice, gaze, Slack,
  Prometheus, GitHub webhooks, internal events — all merge on one
  bus that the LLM nodes read from.
- **Criticality + preemption** ([§ Preemption](#preemption-rtos-style)):
  every message carries a criticality. A higher-criticality message
  arriving mid-handler **aborts** the running iteration — including
  the in-flight LLM call — and triggers a re-iteration with the
  interrupting message in `ctx.preemptionContext`.
- **Distributed by default**: same node config runs in-process or on
  a remote `brain-agent` over NATS. Stop / start / wake / log /
  mailbox / DLQ all roundtrip transparently.
- **MCP-native**: an `mcp-host` node bridges any MCP server's tools
  onto the bus, so the agent calls `filesystem`, `git`, `slack`,
  `sentry`, … like any other node.

What you build with this: ambient agents that watch the world and
act when it's relevant. Voice + gaze + intent (the flagship demo) is
one example; a Slack-channel listener that summarises during quiet
hours, an IoT controller, a monitoring agent that notices
correlations across Grafana + on-call + recent deploys, are all the
same shape.

---

## Engine

### Bus + mailboxes

`packages/core/src/bus` — same `IBusService` interface, two flavours:

- **`BusService`** (in-process, default) — purely in-memory.
- **`NatsBusService`** — backed by a NATS broker. Multiple brAIn
  processes (an API + N brain-agents on other hosts) share topics.
  Native request/reply for synchronous read-back across the network.

Common features regardless of backend:

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

### Preemption (RTOS-style)

When a higher-criticality message lands while a handler is running,
the runner **aborts** it instead of waiting:

- `ctx.signal: AbortSignal` is exposed to every handler. LLM nodes
  pass it to `generateText({ abortSignal: ctx.signal })`, CLI nodes
  pass it to `spawn(..., { signal })`, MCP nodes pass it to
  `client.callTool(..., { signal })`. The Vercel AI SDK propagates
  it through to the underlying fetch on every provider (Anthropic,
  OpenAI, Google, Ollama).
- The threshold is configurable (default: incoming must exceed
  active-iteration criticality by > 3).
- The next handler invocation sees `ctx.wasPreempted = true` and
  `ctx.preemptionContext.{interrupting_message, previous_messages}`
  so it can decide what to do with the new context.

Verified end-to-end: a 65-second Ollama call gets cut to 809 ms when
preempted (Ollama responds with HTTP 500 to the cancelled request,
visible in `~/.ollama/logs/server.log`).

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

### MCP — `mcp-host` node

`nodes/mcp-host` connects to N MCP servers over stdio (using the
official `@modelcontextprotocol/sdk`), discovers their tools, and
exposes them on the bus:

- `mcp.call` → payload `{server?, tool, arguments?}` → answers on
  `mcp.result`. `ctx.signal` propagates → preemption kills MCP
  calls in flight.
- `mcp.tools.list` → republishes the aggregated toolset on
  `mcp.tools.available` for discovery.

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

## Showcase: ambient perception

[brAIn-perception](https://github.com/tibzejoker/brAIn-perception)
(sibling repo, auto-detected) runs three nodes that demonstrate the
many-to-many model concretely:

- **`voice`** — server-side mic capture + Silero VAD + faster-whisper
  STT + WeSpeaker speaker diarization. Publishes `voice.transcript`
  (criticality bumped on finalised segments so the brain wakes) and
  `voice.speaker.detected`.
- **`gaze`** — server-side webcam + InsightFace recognition + Gazelle
  (DINOv2) gaze direction + MediaPipe iris + Moondream labelling
  what the gaze lands on. Publishes `gaze.target.resolved`.
- **`intent`** — pure-TS correlator (zero Python). Subscribes to
  `voice.transcript` + `gaze.target.resolved`, runs a sliding-window
  correlation by timecode, publishes `intent.detected`.

Combined with `brain` and `chat`, this gives an agent that watches a
room and only responds when **someone is looking at it while
talking** — no wake word, no chat input. The same primitives would
host a Slack-channel listener, a Prometheus-correlated incident
agent, an IoT controller, etc.

The Python-backed `voice` and `gaze` nodes auto-install their venv
+ ML models on first spawn (faster-whisper, Gazelle, Moondream, …)
so a fresh `pnpm start` plus a manual node spawn from the dashboard
boots end-to-end.

---

## In-tree nodes

- **Reasoning**: `brain` (central LLM consciousness with tool-call
  parsing hardened for small models), `developer` (creates new node
  types at runtime via Claude / Codex / Gemini CLI agents),
  `attention` (bridges intents to brain topics).
- **Memory**: `memory` (KV + tags), `memory-vector` (LanceDB +
  Ollama embeddings), `memory-proxy` (LLM-mediated gateway —
  brain talks here, never to the underlying stores),
  `memory-consolidator` (autonomous merger / cleaner).
- **Tools**: `terminal`, `http-bridge`, `cron`, `clock`, `reminder`,
  `echo`, `chat`, `mcp-host`.
- **LLM**: `llm-basic` (Vercel AI SDK wrapper), `llm-cli` (Claude
  Code / Codex / Gemini wrapper).
- **Web demo**: `calc-py` — minimal Python `transport: "web"` node
  that answers expressions over WebSocket.

---

## Quickstart

### Prerequisites

- **Node.js** ≥ 20, **pnpm** 7+
- **Ollama** for local LLM nodes (`ollama pull gemma3:4b`,
  `ollama pull qwen3-embedding:0.6b`)
- **NATS** only for distributed setups (`brew install nats-server`)
- **Python 3.11** only if you check out
  [brAIn-perception](https://github.com/tibzejoker/brAIn-perception)

### Run the framework alone

```bash
pnpm install
pnpm build
pnpm start
# API       → http://localhost:3000
# Dashboard → http://localhost:5173
```

### Pre-wired stacks (require brAIn-perception sibling)

```bash
pnpm dev:voice          # voice + seed
pnpm dev:gaze           # gaze + seed
pnpm dev:intent         # voice + gaze + intent
pnpm dev:vocal-chat     # the full ambient stack (voice + gaze +
                        # intent + chat + brain)
```

### Distributed runtime

```bash
# Broker
nats-server -p 4222

# API host
BRAIN_NATS_URL=nats://<broker>:4222 pnpm start

# Each worker (Pi, GPU box, …)
BRAIN_NATS_URL=nats://<broker>:4222 \
  BRAIN_AGENT_NODES_DIR=$(pwd)/nodes \
  node packages/agent/dist/cli.js
```

The agent appears in the dashboard's **Agents** tab; pick it as
target in the Node Creator to spawn there. Optional env:
`BRAIN_NATS_PREFIX` (default `brain`), `BRAIN_NATS_TOKEN`.

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
GET    /nodes/:id/{logs,mailboxes,dead-letters}

# Types
GET    /types
POST   /types/register   { path }
DELETE /types/:name

# Network + traces
GET    /network                          Full snapshot
GET    /network/messages                 History
GET    /network/traces/:trace_id         Walk a causal chain
POST   /network/traces/:trace_id/replay  Re-publish as fresh emissions
POST   /network/seeds/:name/apply        Apply a YAML seed

# Store + agents
GET    /store/{index,nodes,candidates}
POST   /store/install            { package_name }
GET    /agents

# Node UI
GET    /nodes/:id/ui/            Static node UI
POST   /nodes/:id/ui/send        Publish into the node
GET    /nodes/:id/ui/messages    Conversation log
```

WebSocket events on `/socket.io`: `node:spawned`, `node:killed`,
`node:state_changed`, `message:published`.

---

## What this is not

- **Not a chat framework.** If you want "user types → LLM responds",
  use LangGraph or the Vercel AI SDK directly.
- **Not a workflow engine.** Workflows have a finite shape and
  request-driven execution; brAIn's nodes are open-ended daemons.
- **Not ROS.** ROS is C++/Python, not LLM-native, not distributed
  over NATS, not preemption-aware in the criticality sense.
- **Not a low-code tool.** The dashboard observes; node code is
  TypeScript (or any HTTP/WS-speaking language via `transport: "web"`).

| | brAIn | LangGraph | AutoGen | ROS2 |
|---|---|---|---|---|
| Daemon nodes | ✅ | ❌ (graph runs on demand) | ❌ (conversation) | ✅ |
| Many-to-many bus | ✅ | ❌ | ❌ | ✅ |
| Criticality preemption | ✅ | ❌ | ❌ | ⚠ (priorities, no LLM-aware abort) |
| LLM-native | ✅ | ✅ | ✅ | ❌ |
| Distributed cross-machine | ✅ (NATS) | ❌ | ⚠ | ✅ (DDS) |
| MCP host | ✅ | ⚠ (per-tool wrap) | ⚠ | ❌ |
| Causal trace + replay | ✅ | ⚠ (LangSmith trace, no replay) | ❌ | ❌ |

---

## Tech stack

- **SDK**: TypeScript types only.
- **Core**: TypeScript, pino, eventemitter3, better-sqlite3, uuid,
  ws, nats.js, ai (Vercel SDK), `@modelcontextprotocol/sdk`.
- **API**: NestJS 10, Socket.IO, express.
- **Agent**: tiny TypeScript daemon (`packages/agent`) — `brain-agent`
  CLI bin.
- **Dashboard**: React 19, React Flow, d3-force, Tailwind v4, Vite.
- **Bus**: in-memory by default; NATS when `BRAIN_NATS_URL` is set.
- **Persistence**: SQLite via better-sqlite3.
- **Monorepo**: pnpm workspaces (cross-repo via sibling paths to
  `../brAIn-perception/nodes/*`).
- **Python helper**: `packages/python-sdk` (`brain-web`) for
  `transport: "web"` nodes.
- **Tests**: vitest (TS), unittest (Python). NATS / LLM / MCP
  integration tests skip gracefully when the dependency isn't on
  PATH.

---

## Tests

```bash
pnpm test                                    # all
RUN_LLM_E2E=1 npx vitest run tests/preemption-llm-e2e.test.ts
RUN_MCP_E2E=1 npx vitest run tests/mcp-host-public-server-e2e.test.ts
```

~30 vitest files. Coverage by area:

- **Engine core**: bus topic matching, mailbox + backpressure,
  registries, dynamic-scanner hash dance, type-validator,
  tool-parser, message-formatter aliases.
- **Runners**: lifecycle, idempotent teardown + onSpawn, handler
  crash recovery, dead-letter capture, handler timeout, **preemption**
  unit + LLM E2E.
- **Distributed**: NatsBusService routing + anti-loop, real
  `nats-server` integration, agent announcements + zombie cleanup,
  remote-spawn full cycle.
- **MCP**: in-process echo server fixture + real
  `@modelcontextprotocol/server-filesystem` E2E.
- **Memory + brain end-to-end**: secret retrieval, multi-service
  workflows, consolidator, LLM budget exhaustion.
- **Misc**: child-server SIGTERM → SIGKILL escalation, HTTP bridge.

---

## Lint

ESLint strict. `pnpm lint` must pass with **0 errors and 0
warnings**. Notable rules: no `any`, no `console`, no inline
`eslint-disable`, `consistent-type-imports`, `prefer-readonly`,
`no-non-null-assertion`, `react-hooks/exhaustive-deps`,
`no-floating-promises`, `require-await`, `max-lines: 300` per
source file.

---

## License

[MIT](./LICENSE) — Copyright © 2026 Thibaut Léaux.
