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
import { BrainService, NatsBusService, logger } from "@brain/core";

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
const DEFAULT_ANNOUNCE_MS = 10_000;
const ANNOUNCE_TOPIC = "brain.agents.discover";

export interface AgentAnnouncement {
  agent_id: string;
  host: string;
  pid: number;
  started_at: number;
  types: string[];
  /** Wall-clock ms — receivers expire stale agents past 3× announce interval. */
  ts: number;
}

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
      this.opts.announceIntervalMs ?? DEFAULT_ANNOUNCE_MS,
    );

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
      topic: ANNOUNCE_TOPIC,
      type: "text",
      criticality: 0,
      payload: { content: JSON.stringify(payload) },
      metadata: payload as unknown as Record<string, unknown>,
    });
  }
}

/**
 * Helper for the API side: subscribes to discovery announcements and
 * returns a snapshot of currently-live agents (with TTL pruning).
 */
export class AgentDirectory {
  private readonly seen = new Map<string, AgentAnnouncement>();
  private readonly ttlMs: number;

  constructor(private readonly bus: NatsBusService, opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_ANNOUNCE_MS * 3;
  }

  attach(): void {
    // brAIn API process subscribes via a synthetic node id; the bus's
    // anti-loop is by `from`, and the API never publishes from this id,
    // so we'll receive every agent's announcement.
    const apiId = "__brain.api.agents__";
    this.bus.subscribe(apiId, ANNOUNCE_TOPIC);
    this.bus.on(`message:${apiId}`, (msg) => {
      try {
        const ann = JSON.parse(
          (msg.payload as { content: string }).content,
        ) as AgentAnnouncement;
        this.seen.set(ann.agent_id, ann);
      } catch { /* malformed announcement — ignore */ }
    });
  }

  list(): AgentAnnouncement[] {
    const cutoff = Date.now() - this.ttlMs;
    const out: AgentAnnouncement[] = [];
    for (const [id, ann] of this.seen) {
      if (ann.ts < cutoff) this.seen.delete(id);
      else out.push(ann);
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }
}

export const ANNOUNCE = { topic: ANNOUNCE_TOPIC, defaultIntervalMs: DEFAULT_ANNOUNCE_MS };
