/**
 * Agent-presence helper — shared by the standalone `brain-agent` CLI
 * AND by the API when it joins an external broker.
 *
 * Wiring:
 *   1. **Announce** the local `BrainService.typeRegistry.list()` on
 *      `brain.agents.discover` every `announceIntervalMs` (default 10s)
 *      so any other API listening to the bus sees this host's installable
 *      types in its `/agents` directory.
 *   2. **Control channel** — subscribe to `brain.agents.<self>.{spawn,
 *      kill,stop,start,wake}` and dispatch each request to the local
 *      BrainService. Lets a remote dashboard place a node on THIS host.
 *   3. **Readback channel** — NATS request-reply on
 *      `brain.agents.<self>.read.{logs,mailboxes,dead_letters}` so the
 *      remote dashboard can pull this host's node telemetry.
 *
 * The CLI agent was the original consumer; pulling the logic out here
 * lets a full-API instance announce itself the same way as soon as it
 * joins someone else's hub.
 */
import type { NodeInstanceConfig } from "@brain/sdk";
import type { BrainService } from "../brain.service";
import type { NatsBusService } from "../bus";
import type { IBusService } from "../bus/bus.interface";
import { logger } from "../logger";
import * as path from "path";
import * as fs from "fs";
import { matchTopic } from "../bus/bus.matcher";
import { AGENT_ANNOUNCE_TOPIC, AGENT_ANNOUNCE_DEFAULT_MS, type AgentAnnouncement } from "./agent-directory";

export interface AgentPresenceOptions {
  brain: BrainService;
  /** The bus to publish/subscribe on. NatsBusService in production,
   *  IBusService in test scaffolding. */
  bus: NatsBusService | IBusService;
  /** Stable per-host id used in `agent_id` and in the
   *  `brain.agents.<id>.*` control topic. Should survive process
   *  restart so dashboards don't re-list it as a new agent. */
  agentId: string;
  /** Friendly label shown in dashboards. */
  host: string;
  /** Optional — defaults to process.pid. */
  pid?: number;
  /** Optional — defaults to Date.now(). */
  startedAt?: number;
  /** Default 10000ms. */
  announceIntervalMs?: number;
}

export interface AgentPresenceHandle {
  readonly agentId: string;
  stop(): void;
}

export function startAgentPresence(opts: AgentPresenceOptions): AgentPresenceHandle {
  const { brain, bus, agentId, host } = opts;
  const pid = opts.pid ?? process.pid;
  const startedAt = opts.startedAt ?? Date.now();
  const intervalMs = opts.announceIntervalMs ?? AGENT_ANNOUNCE_DEFAULT_MS;
  const log = logger.child({ svc: "agent-presence", id: agentId, host });
  const controlNodeId = `agent:${agentId}:control`;

  // Publish one AgentAnnouncement on the discovery topic. Idempotent —
  // every call ships the CURRENT type list, so dashboards reflect any
  // lib pull/install done since the previous tick within ~intervalMs.
  const announce = (): void => {
    const payload: AgentAnnouncement = {
      agent_id: agentId,
      host,
      pid,
      started_at: startedAt,
      types: brain.typeRegistry.list().map((t) => t.name),
      ts: Date.now(),
    };
    try {
      bus.publish({
        from: `agent:${agentId}`,
        topic: AGENT_ANNOUNCE_TOPIC,
        type: "text",
        criticality: 0,
        payload: { content: JSON.stringify(payload) },
        metadata: payload as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.warn({ err }, "announce publish failed (bus likely down)");
    }
  };

  // Control channel — dispatch remote spawn/kill/stop/start/wake requests
  // to the local BrainService. Mirrors what the CLI `Agent` does, kept
  // separate so the API can reuse it without subclassing.
  const attachControl = (): void => {
    for (const action of ["spawn", "kill", "stop", "start", "wake"]) {
      bus.subscribe(controlNodeId, `brain.agents.${agentId}.${action}`);
    }
    bus.on(`message:${controlNodeId}`, (msg) => {
      void handleControl(msg.topic, (msg.payload as { content: string }).content);
    });
  };

  const handleControl = async (topic: string, content: string): Promise<void> => {
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      const action = topic.split(".").pop() ?? "";
      const nodeId = (data.node_id as string | undefined) ?? (data.id as string | undefined);
      const message = data.message as string | undefined;
      if (action === "spawn") {
        const cfg = data.config as NodeInstanceConfig | undefined;
        if (!cfg) { log.warn({ topic }, "spawn request missing config"); return; }
        const id = (data.id as string | undefined) ?? cfg.id;
        const merged: NodeInstanceConfig = { ...cfg, id, transport: "process" };
        const info = await brain.spawnNode(merged);
        log.info({ id: info.id, type: info.type, name: info.name }, "spawned remote node locally");
        return;
      }
      if (!nodeId) { log.warn({ topic }, "control request missing node_id"); return; }
      let ok = false;
      switch (action) {
        case "kill":  ok = brain.killNode(nodeId, undefined, data.reason as string | undefined); break;
        case "stop":  ok = brain.stopNode(nodeId); break;
        case "start": ok = await brain.startNode(nodeId, undefined, message); break;
        default: log.warn({ topic }, "unknown control action"); return;
      }
      log.info({ id: nodeId, action, ok }, "dispatched remote control");
    } catch (err) {
      log.warn({ err, topic }, "control handler failed");
    }
  };

  // Readback channel — request-reply for logs / mailboxes / dead-letters.
  // Only NatsBusService supports respondToRequests; in-memory test buses
  // skip it gracefully.
  const attachReadback = (): void => {
    const natsBus = bus as NatsBusService & { respondToRequests?: typeof NatsBusService.prototype.respondToRequests };
    if (typeof natsBus.respondToRequests !== "function") return;
    natsBus.respondToRequests(`brain.agents.${agentId}.read.logs`, (payload) => {
      const { node_id, last } = payload as { node_id: string; last?: number };
      return brain.getNodeLogs(node_id, last);
    });
    natsBus.respondToRequests(`brain.agents.${agentId}.read.mailboxes`, (payload) => {
      const { node_id } = payload as { node_id: string };
      return brain.getNodeMailboxes(node_id);
    });
    natsBus.respondToRequests(`brain.agents.${agentId}.read.dead_letters`, (payload) => {
      const { node_id } = payload as { node_id: string };
      return brain.getNodeDeadLetters(node_id);
    });

    // LLM availability + per-node resolution preview from a peer's side
    // panel. The dropdown shows the OWNER hub's reachable models — picking
    // an Ollama model that only exists on our Mac while the node lives on
    // the PC would be silently broken otherwise.
    natsBus.respondToRequests(`brain.agents.${agentId}.read.llm.models`, () => {
      const out: Array<{ spec: string; provider: string; model: string }> = [];
      for (const s of brain.llm.getStatuses()) {
        if (!s.available) continue;
        for (const m of s.models) out.push({ spec: `${s.name}/${m}`, provider: s.name, model: m });
      }
      return out;
    });
    natsBus.respondToRequests(`brain.agents.${agentId}.read.llm.clis`, async () => {
      await brain.cli.initialize();
      return brain.cli.getStatuses();
    });
    natsBus.respondToRequests(`brain.agents.${agentId}.read.llm.preview`, (payload) => {
      const { node_id } = payload as { node_id: string };
      const node = brain.instanceRegistry.get(node_id);
      if (!node) return { requested: "", resolved: "", layer: "fallback", fell_back: false, error: "Node not found on this hub" };
      const cfg = brain.llmConfig.get();
      const candidates: string[] = [];
      const nodeModel = node.config_overrides?.model as string | undefined;
      if (nodeModel) candidates.push(nodeModel);
      if (cfg.defaultModel) candidates.push(cfg.defaultModel);
      candidates.push(...cfg.fallbackChain);
      const layers: ("node-override" | "global-default" | "fallback")[] = [];
      if (nodeModel) layers.push("node-override");
      if (cfg.defaultModel) layers.push("global-default");
      for (let i = 0; i < cfg.fallbackChain.length; i++) layers.push("fallback");
      const top = candidates[0] ?? "ollama/gemma4:e4b";
      for (let i = 0; i < candidates.length; i++) {
        const spec = candidates[i];
        if (brain.llm.isSpecAvailable(spec)) {
          return { requested: top, resolved: spec, layer: layers[i] ?? "fallback", fell_back: spec !== top, fallback_reason: spec !== top ? `${top} unavailable` : undefined };
        }
      }
      return { requested: top, resolved: top, layer: layers[0] ?? "fallback", fell_back: false };
    });

    // Live wiring from a peer's dashboard — add or remove a subscription /
    // publish on a node WE host. Idempotent on both sides: "already exists"
    // on add returns the existing entry, "not present" on remove returns
    // removed:false. Persists to DB so the change survives a restart on
    // the owner. Snapshot publisher picks the change up on its next tick.
    natsBus.respondToRequests(`brain.agents.${agentId}.update_subscriptions`, (payload) => {
      const { node_id, op, topic, description, inputSchema, outputSchema, internal, min_criticality } = payload as {
        node_id: string; op: "add" | "remove"; topic: string;
        description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>;
        internal?: boolean; min_criticality?: number;
      };
      try {
        if (op === "add") return { ok: true, ...brain.addNodeSubscription(node_id, topic, { description, inputSchema, outputSchema, internal, min_criticality }) };
        return { ok: true, ...brain.removeNodeSubscription(node_id, topic) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    natsBus.respondToRequests(`brain.agents.${agentId}.update_publishes`, (payload) => {
      const { node_id, op, topic } = payload as { node_id: string; op: "add" | "remove"; topic: string };
      try {
        if (op === "add") return { ok: true, ...brain.addNodePublish(node_id, topic) };
        return { ok: true, ...brain.removeNodePublish(node_id, topic) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    // 2-layer wiring: peer dashboard binds / unbinds a topic on a declared
    // port. Same idempotency contract as update_subscriptions / publishes.
    natsBus.respondToRequests(`brain.agents.${agentId}.update_port_bindings`, (payload) => {
      const { node_id, op, side, port, topic } = payload as {
        node_id: string; op: "bind" | "unbind"; side: "inputs" | "outputs"; port: string; topic: string;
      };
      try {
        if (op === "bind") return { ok: true, ...brain.bindPortTopic(node_id, side, port, topic) };
        return { ok: true, ...brain.unbindPortTopic(node_id, side, port, topic) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // Config patch from a peer's dashboard side-panel (edit LLM model, dev
    // mode, etc.). Applies the same merge logic as the local controller —
    // null clears a key, anything else overwrites — then persists via
    // updateNodeConfig so the change survives an API restart on the owner.
    natsBus.respondToRequests(`brain.agents.${agentId}.update_config`, (payload) => {
      const { node_id, patch } = payload as { node_id: string; patch: Record<string, unknown> };
      const node = brain.instanceRegistry.get(node_id);
      if (!node) return { ok: false, error: "Node not found on this hub" };
      const overrides = node.config_overrides ?? {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete overrides[k];
        else overrides[k] = v;
      }
      brain.updateNodeConfig(node_id, overrides);
      return { ok: true, config_overrides: overrides };
    });

    // ─── Cross-machine UI/RPC proxy ────────────────────────────────────────
    // The local API on ANOTHER machine sees a node owned by us (owner_hub ==
    // this agent) and routes node-UI calls through these channels rather than
    // hitting our HTTP directly. Result: a UI loaded in any dashboard can
    // drive a node hosted anywhere, with the bus as the only transport.

    // RPC: publish a bus message on a node's input topic (new shape — body is
    // the payload, topic is the URL path component).
    natsBus.respondToRequests(`brain.agents.${agentId}.node_call`, (payload) => {
      const { nodeId, topic, body } = payload as { nodeId: string; topic: string; body: unknown };
      const content = typeof body === "string" ? body : JSON.stringify(body ?? {});
      // Choose the `from` based on whether the target node subscribes to
      // the topic.
      //
      //  - OUTBOUND topic (node doesn't subscribe — e.g. chat.input emitted
      //    by `chat`): keep `from: nodeId` so the message appears in the
      //    node's sent-history (`/node/:id/messages` filters by `from`).
      //
      //  - INBOUND topic (node subscribes — e.g. tts.speak on a tts node):
      //    use a synthetic `ui:<nodeId>`. The bus skips delivery to the
      //    publisher's own subscriptions to prevent self-loops, so setting
      //    `from: nodeId` here would silently drop the message from the
      //    very mailbox the user expects to trigger. With two instances of
      //    the same node type this manifests as "the other one speaks" —
      //    the broadcast still reaches the OTHER subscriber but not the
      //    one whose UI the user is operating.
      const subs = brain.bus.getSubscriptions(nodeId);
      const isInbound = subs.some((s) => matchTopic(s.pattern, topic));
      const from = isInbound ? `ui:${nodeId}` : nodeId;
      const msg = brain.bus.publish({
        from,
        topic,
        type: "text",
        criticality: 3,
        payload: { content },
        metadata: { via: "node-call", target_node_id: nodeId },
      });
      return { message_id: msg.id };
    });

    // Legacy /ui/send equivalent (kept while we migrate node UIs to the new
    // shape). Same publish but the caller chooses `from` / `criticality`.
    natsBus.respondToRequests(`brain.agents.${agentId}.ui_send`, (payload) => {
      const p = payload as {
        nodeId: string; topic: string; content: string;
        from?: string; criticality?: number; metadata?: Record<string, unknown>;
      };
      const msg = brain.bus.publish({
        from: p.from ?? p.nodeId,
        topic: p.topic,
        type: "text",
        criticality: p.criticality ?? 3,
        payload: { content: p.content },
        metadata: p.metadata,
      });
      return { message_id: msg.id };
    });

    // Read this node's mailbox + recent sent traffic. Mirrors the local
    // GET /nodes/:id/ui/messages so the remote dashboard polls one endpoint.
    natsBus.respondToRequests(`brain.agents.${agentId}.ui_messages`, (payload) => {
      const { nodeId } = payload as { nodeId: string };
      // A node's OWN published messages (status, cache snapshots, results) are
      // what its UI panel renders. They must NOT be crowded out by a high-rate
      // INBOUND stream (e.g. a phone at 60 Hz accel): a single sorted
      // `slice(-50)` would return 50 of the newest accel samples and drop every
      // status/cache publish, so the panel showed "no device" / "Pre-warming"
      // even though the node was healthy. Keep the two sides on separate
      // budgets and never trim the published side.
      const sent = brain.bus.getMessageHistory({ from: nodeId, last: 50 });
      const received = brain.bus.readMessages(nodeId, { mode: "all", limit: 20 });
      const seen = new Set<string>();
      const all: typeof received = [];
      for (const m of [...received, ...sent]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(m);
      }
      all.sort((a, b) => a.timestamp - b.timestamp);
      return all;
    });

    // Static UI file. Returns base64 content + content-type so the remote
    // API can serve the same bytes its local sendFile would. We honour the
    // same uiDir confinement as the HTTP route — no path traversal escapes
    // the node's `ui/` folder even over NATS.
    natsBus.respondToRequests(`brain.agents.${agentId}.ui_file`, (payload) => {
      const { nodeId, subpath } = payload as { nodeId: string; subpath?: string };
      const node = brain.instanceRegistry.get(nodeId);
      if (!node) return { status: 404, error: "node not found" };
      const typeConfig = brain.typeRegistry.get(node.type);
      if (!typeConfig?.has_ui) return { status: 404, error: "no ui" };
      const typePath = brain.typeRegistry.getPath(node.type);
      if (!typePath) return { status: 404, error: "type path missing" };
      const uiDir = path.join(typePath, "ui");
      const filePath = path.join(uiDir, subpath || "index.html");
      if (!filePath.startsWith(uiDir)) return { status: 403, error: "forbidden" };
      if (!fs.existsSync(filePath)) return { status: 404, error: "file not found" };
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript; charset=utf-8",
        ".mjs":  "application/javascript; charset=utf-8",
        ".css":  "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg":  "image/svg+xml",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".ico":  "image/x-icon",
        ".woff": "font/woff",
        ".woff2":"font/woff2",
      } as Record<string,string>)[ext] || "application/octet-stream";
      return { status: 200, contentType: mime, base64: buf.toString("base64") };
    });
  };

  attachControl();
  attachReadback();
  announce();
  const timer: NodeJS.Timeout = setInterval(announce, intervalMs);
  log.info({ types: brain.typeRegistry.list().length, intervalMs }, "agent presence started");

  return {
    agentId,
    stop(): void { clearInterval(timer); },
  };
}
