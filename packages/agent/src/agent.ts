/**
 * brAIn Agent — a lightweight daemon hosting nodes on a remote machine.
 *
 * The agent boots a regular `BrainService` but wires its bus to a
 * shared NATS broker, so every node it runs sits on the same bus as
 * the brAIn API and any other agent. Announcement / control / readback
 * wiring is delegated to `startAgentPresence` from @brain/core so the
 * API can announce itself the same way when it joins an external hub.
 */
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  BrainService, NatsBusService, logger,
  startAgentPresence,
  type AgentPresenceHandle,
} from "@brain/core";

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
  /** Directory (or array of directories) holding node packages
   *  (`nodes/<type>/config.json`). The agent scans each one at boot
   *  and registers every type it finds, so the brAIn API discovers
   *  this agent's installable types via the announcement and can spawn
   *  them remotely. Empty / missing dirs are skipped with a warning. */
  nodesDir: string | string[];
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
  private presence: AgentPresenceHandle | null = null;
  private stopped = false;

  constructor(private readonly opts: AgentOptions) {
    this.id = opts.agentId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
    this.host = opts.host ?? hostname();
  }

  async start(): Promise<void> {
    const log = logger.child({ svc: "agent", id: this.id, host: this.host });

    const dirs = Array.isArray(this.opts.nodesDir) ? this.opts.nodesDir : [this.opts.nodesDir];
    const presentDirs = dirs.filter((d) => {
      const ok = existsSync(d);
      if (!ok) log.warn({ dir: d }, "agent: nodes dir not found, skipping");
      return ok;
    });
    if (presentDirs.length === 0) {
      log.warn("agent: no nodes dirs resolved — this remote will announce zero installable types");
    } else {
      log.info({ dirs: presentDirs }, "agent: scanning nodes dirs");
    }

    log.info({ url: this.opts.natsUrl }, "starting NATS bus");
    this.natsBus = new NatsBusService({
      url: this.opts.natsUrl,
      prefix: this.opts.natsPrefix ?? DEFAULT_PREFIX,
      token: this.opts.natsToken,
    });
    await this.natsBus.connect();
    // Token rotation upstream → broker rejects us → exit so the user
    // sees the agent died (and knows to restart with the fresh token)
    // rather than have it loop forever on Authorization Violation.
    this.natsBus.on("auth:rejected", ({ reason }: { reason: string }) => {
      log.error({ reason }, "broker rejected auth — token likely rotated; exiting");
      process.exit(2);
    });

    this.brain = new BrainService(this.opts.dbPath, this.natsBus);
    this.brain.bootstrap(presentDirs.length > 0 ? presentDirs : dirs);

    // Restore any nodes this agent had spawned previously (so a restart
    // doesn't lose work).
    const restored = await this.brain.restore();
    if (restored > 0) log.info({ restored }, "restored persisted nodes");

    // Announce + control + readback — same wiring the API now reuses
    // when it joins an external broker (DRY via @brain/core).
    this.presence = startAgentPresence({
      brain: this.brain,
      bus: this.natsBus,
      agentId: this.id,
      host: this.host,
      startedAt: this.startedAt,
      announceIntervalMs: this.opts.announceIntervalMs,
    });

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
    this.presence?.stop();
    this.presence = null;
    try { this.brain?.killAll(); } catch { /* ignore */ }
    try { await this.natsBus?.close(); } catch { /* ignore */ }
    process.exit(0);
  }
}
