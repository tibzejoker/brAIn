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
