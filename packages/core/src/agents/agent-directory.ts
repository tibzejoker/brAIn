/**
 * Aggregates discovery announcements from brain-agent processes.
 *
 * The framework uses a single well-known topic (`brain.agents.discover`)
 * for agents to advertise themselves. The directory subscribes to it
 * via a synthetic node id, captures the latest announcement per agent,
 * and prunes entries that haven't refreshed within `ttlMs` (default
 * 3× the announce interval).
 *
 * Lives in @brain/core so the API can list connected agents without
 * pulling in the agent package; the @brain/agent package re-exports
 * `AgentAnnouncement` for the daemon side.
 */
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
}

export class AgentDirectory {
  private readonly seen = new Map<string, AgentAnnouncement>();
  private readonly ttlMs: number;

  constructor(private readonly bus: IBusService, opts: AgentDirectoryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? AGENT_ANNOUNCE_DEFAULT_MS * 3;
  }

  /**
   * Hook the directory onto the bus. Idempotent — safe to call once at
   * BrainService boot. The synthetic node id avoids any chance of
   * colliding with a real instance.
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
        this.seen.set(ann.agent_id, ann);
      } catch { /* malformed announcement — ignore */ }
    });
  }

  /** Snapshot of currently-live agents, sorted by host. Pruned by ttlMs. */
  list(): AgentAnnouncement[] {
    const cutoff = Date.now() - this.ttlMs;
    const out: AgentAnnouncement[] = [];
    for (const [id, ann] of this.seen) {
      if (ann.ts < cutoff) this.seen.delete(id);
      else out.push(ann);
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }

  /** True if at least one announcement matching `agent_id` has been seen recently. */
  has(agentId: string): boolean {
    return this.list().some((a) => a.agent_id === agentId);
  }
}
