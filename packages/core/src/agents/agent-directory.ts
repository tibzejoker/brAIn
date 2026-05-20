/**
 * Aggregates discovery announcements from brain-agent processes.
 *
 * The framework uses a single well-known topic (`brain.agents.discover`)
 * for agents to advertise themselves. The directory subscribes to it
 * via a synthetic node id, captures the latest announcement per agent,
 * and prunes entries that haven't refreshed within `ttlMs` (default
 * 3× the announce interval).
 *
 * Emits these events callers can subscribe to:
 *   - `agent:added`     when an unseen agent_id first appears
 *   - `agent:announced` on every announcement (new or refresh) — carries the
 *                       latest payload, so consumers can react in real time to
 *                       both arrivals and in-place changes (e.g. updated types)
 *   - `agent:expired`   when an entry hasn't refreshed past ttl
 *
 * Lives in @brain/core so the API can list connected agents without
 * pulling in the agent package; the @brain/agent package re-exports
 * `AgentAnnouncement` for the daemon side.
 */
import EventEmitter from "eventemitter3";
import type { IBusService } from "../bus/bus.interface";

export const AGENT_ANNOUNCE_TOPIC = "brain.agents.discover";
export const AGENT_ANNOUNCE_DEFAULT_MS = 10_000;

export interface AgentAnnouncement {
  agent_id: string;
  host: string;
  pid: number;
  started_at: number;
  types: string[];
  /** Wall-clock ms — receivers expire stale agents past `ttlMs`. */
  ts: number;
}

export interface AgentDirectoryOptions {
  /** TTL for entries in ms; defaults to 3× the announce interval. */
  ttlMs?: number;
  /** How often to run the expiry sweep; defaults to ttlMs / 3. */
  sweepIntervalMs?: number;
}

export class AgentDirectory extends EventEmitter {
  private readonly seen = new Map<string, AgentAnnouncement>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly bus: IBusService, opts: AgentDirectoryOptions = {}) {
    super();
    this.ttlMs = opts.ttlMs ?? AGENT_ANNOUNCE_DEFAULT_MS * 3;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3));
  }

  /**
   * Hook the directory onto the bus and start the expiry sweep.
   * Idempotent — safe to call once at BrainService boot. The synthetic
   * node id avoids any chance of colliding with a real instance.
   */
  attach(): void {
    const apiId = "__brain.api.agents__";
    this.bus.subscribe(apiId, AGENT_ANNOUNCE_TOPIC);
    this.bus.on(`message:${apiId}`, (msg) => {
      try {
        const ann = JSON.parse(
          (msg.payload as { content: string }).content,
        ) as AgentAnnouncement;
        if (!ann.agent_id) return;
        const isNew = !this.seen.has(ann.agent_id);
        this.seen.set(ann.agent_id, ann);
        if (isNew) this.emit("agent:added", ann);
        // Always fan out the latest payload so live consumers (dashboard
        // socket) can drop the announce polling entirely — re-announces also
        // surface here so an agent's changing `types` propagate instantly.
        this.emit("agent:announced", ann);
      } catch { /* malformed announcement — ignore */ }
    });

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs);
      // Don't keep the Node.js event loop alive just for this timer.
      this.sweepTimer.unref();
    }
  }

  /** Stop the sweep timer. Call this in tests / on graceful shutdown. */
  detach(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  /** Snapshot of currently-live agents, sorted by host. Pruned by ttlMs. */
  list(): AgentAnnouncement[] {
    this.sweepExpired();
    return Array.from(this.seen.values()).sort((a, b) => a.host.localeCompare(b.host));
  }

  /** True if at least one announcement matching `agent_id` has been seen recently. */
  has(agentId: string): boolean {
    return this.list().some((a) => a.agent_id === agentId);
  }

  private sweepExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ann] of this.seen) {
      if (ann.ts < cutoff) {
        this.seen.delete(id);
        this.emit("agent:expired", ann);
      }
    }
  }
}
