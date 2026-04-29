/**
 * brAIn Agent — a lightweight daemon hosting nodes on a remote machine.
 *
 * The agent boots a regular `BrainService` but wires its bus to a
 * shared NATS broker, so every node it runs sits on the same bus as
 * the brAIn API and any other agent. The agent announces itself on
 * the discovery topic so the API can list connected agents in its
 * dashboard ("⊞ Agents" tab — Phase 4.5).
 *
 * Default behaviour is intentionally minimal: scan the local
 * `nodes/` directory, register types, advertise. A future revision
 * will accept spawn-requests over NATS so the API can place a node
 * on a specific agent (Phase 4.4).
 */
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  BrainService, NatsBusService, logger,
  AGENT_ANNOUNCE_TOPIC,
  AGENT_ANNOUNCE_DEFAULT_MS,
  type AgentAnnouncement,
} from "@brain/core";
import type { NodeInstanceConfig } from "@brain/sdk";

export type { AgentAnnouncement } from "@brain/core";
export { AgentDirectory } from "@brain/core";

export interface AgentOptions {
  /** Stable id for this agent. Defaults to `<host>-<8 random>`. */
  agentId?: string;
  /** Friendly host label for the dashboard. Defaults to `os.hostname()`. */
  host?: string;
  /** NATS broker url. */
  natsUrl: string;
  /** Bus subject prefix; must match the brAIn API's prefix. */
  natsPrefix?: string;
  /** Optional bearer token for the broker. */
  natsToken?: string;
  /** Directory holding node packages (`nodes/<type>/config.json`). */
  nodesDir: string;
  /** Local SQLite path for the agent's persistent state. */
  dbPath: string;
  /** Interval between discovery announcements (ms). Default 10s. */
  announceIntervalMs?: number;
}

const DEFAULT_PREFIX = "brain";

export class Agent {
  readonly id: string;
  readonly host: string;
  readonly startedAt = Date.now();
  private brain: BrainService | null = null;
  private natsBus: NatsBusService | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: AgentOptions) {
    this.id = opts.agentId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
    this.host = opts.host ?? hostname();
  }

  async start(): Promise<void> {
    const log = logger.child({ svc: "agent", id: this.id, host: this.host });

    if (!existsSync(this.opts.nodesDir)) {
      log.warn({ dir: this.opts.nodesDir }, "agent: nodes dir not found, continuing with empty registry");
    }

    log.info({ url: this.opts.natsUrl }, "starting NATS bus");
    this.natsBus = new NatsBusService({
      url: this.opts.natsUrl,
      prefix: this.opts.natsPrefix ?? DEFAULT_PREFIX,
      token: this.opts.natsToken,
    });
    await this.natsBus.connect();

    this.brain = new BrainService(this.opts.dbPath, this.natsBus);
    this.brain.bootstrap(this.opts.nodesDir);

    // Restore any nodes this agent had spawned previously (so a restart
    // doesn't lose work).
    const restored = await this.brain.restore();
    if (restored > 0) log.info({ restored }, "restored persisted nodes");

    this.announce();
    this.announceTimer = setInterval(
      () => this.announce(),
      this.opts.announceIntervalMs ?? AGENT_ANNOUNCE_DEFAULT_MS,
    );

    // Listen for remote spawn/kill requests addressed to this agent.
    this.attachControlChannel();
    // Answer log/mailbox read-back requests from the API.
    this.attachReadbackChannel();

    // Graceful shutdown so child runners' teardowns fire.
    const onSignal = (sig: NodeJS.Signals): void => {
      log.info({ sig }, "agent: shutting down");
      void this.stop();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    log.info({ types: this.brain.typeRegistry.list().length }, "agent ready");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    try { this.brain?.killAll(); } catch { /* ignore */ }
    try { await this.natsBus?.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  /**
   * Subscribe (via the bus, just like any other node) to every agent
   * control topic — `brain.agents.<self>.{spawn,kill,stop,start,wake}`.
   * Each incoming request is decoded and dispatched to the local
   * BrainService. The runner for the addressed node lives here.
   */
  private attachControlChannel(): void {
    const brain = this.brain;
    const bus = this.natsBus;
    if (!brain || !bus) return;
    const controlNodeId = `agent:${this.id}:control`;
    for (const action of ["spawn", "kill", "stop", "start", "wake"]) {
      bus.subscribe(controlNodeId, `brain.agents.${this.id}.${action}`);
    }
    bus.on(`message:${controlNodeId}`, (msg) => {
      void this.handleControl(msg.topic, (msg.payload as { content: string }).content);
    });
  }

  private async handleControl(topic: string, content: string): Promise<void> {
    const brain = this.brain;
    if (!brain) return;
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      const action = topic.split(".").pop() ?? "";
      const nodeId = (data.node_id as string | undefined) ?? (data.id as string | undefined);
      const message = data.message as string | undefined;

      if (action === "spawn") {
        const cfg = data.config as NodeInstanceConfig | undefined;
        if (!cfg) { logger.warn({ topic }, "agent: spawn request missing config"); return; }
        // Honour the API-allocated id so both sides reference the same instance.
        const id = (data.id as string | undefined) ?? cfg.id;
        const merged: NodeInstanceConfig = { ...cfg, id, transport: "process" };
        const info = await brain.spawnNode(merged);
        logger.info({ id: info.id, type: info.type, name: info.name }, "agent: spawned remote node locally");
        return;
      }

      if (!nodeId) { logger.warn({ topic }, "agent: control request missing node_id"); return; }
      let ok = false;
      switch (action) {
        case "kill":
          ok = brain.killNode(nodeId, undefined, data.reason as string | undefined);
          break;
        case "stop":
          ok = brain.stopNode(nodeId);
          break;
        case "start":
          ok = await brain.startNode(nodeId, undefined, message);
          break;
        case "wake":
          ok = brain.wakeNode(nodeId, undefined, message);
          break;
        default:
          logger.warn({ topic }, "agent: unknown control action");
          return;
      }
      logger.info({ id: nodeId, action, ok }, "agent: dispatched remote control");
    } catch (err) {
      logger.warn({ err, topic }, "agent: control handler failed");
    }
  }

  /**
   * Register NATS request-reply handlers so the API can read this
   * agent's local node logs and mailboxes synchronously. The
   * payload is `{ node_id, last? }`; the response mirrors what
   * `BrainService.getNodeLogs` / `getNodeMailboxes` would return for
   * a local node.
   */
  private attachReadbackChannel(): void {
    const brain = this.brain;
    const bus = this.natsBus;
    if (!brain || !bus) return;
    bus.respondToRequests(`brain.agents.${this.id}.read.logs`, (payload) => {
      const { node_id, last } = payload as { node_id: string; last?: number };
      return brain.getNodeLogs(node_id, last);
    });
    bus.respondToRequests(`brain.agents.${this.id}.read.mailboxes`, (payload) => {
      const { node_id } = payload as { node_id: string };
      return brain.getNodeMailboxes(node_id);
    });
  }

  private announce(): void {
    const brain = this.brain;
    const bus = this.natsBus;
    if (!brain || !bus) return;
    const payload: AgentAnnouncement = {
      agent_id: this.id,
      host: this.host,
      pid: process.pid,
      started_at: this.startedAt,
      types: brain.typeRegistry.list().map((t) => t.name),
      ts: Date.now(),
    };
    bus.publish({
      from: `agent:${this.id}`,
      topic: AGENT_ANNOUNCE_TOPIC,
      type: "text",
      criticality: 0,
      payload: { content: JSON.stringify(payload) },
      metadata: payload as unknown as Record<string, unknown>,
    });
  }
}

/** Convenience constants for callers preferring named exports. */
export const ANNOUNCE = {
  topic: AGENT_ANNOUNCE_TOPIC,
  defaultIntervalMs: AGENT_ANNOUNCE_DEFAULT_MS,
};
