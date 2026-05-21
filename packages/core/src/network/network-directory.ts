/**
 * Aggregates `NetworkSnapshot`s from peer hubs on the shared bus.
 *
 * Mirror of {@link AgentDirectory}, but for *running nodes* rather than
 * installable types. Subscribes to `brain.network.snapshot` via a
 * synthetic node id, keeps the latest snapshot per peer hub, prunes hubs
 * that stop heartbeating past `ttlMs`, and drops a hub instantly on a
 * `brain.network.bye`. Excludes our own hub so a peer never lists itself.
 *
 * Emits:
 *   - `hub:added`    when an unseen hub first appears
 *   - `hub:snapshot` on every snapshot (new or refresh) — carries the
 *                    full payload so live consumers (the dashboard socket)
 *                    can re-render the merged graph in real time
 *   - `hub:expired`  when a hub goes silent past ttl or sends `bye`
 *
 * `mergedNodes()` is the key accessor: every remote node stamped with its
 * `owner_hub`, ready to union with the local registry for a single
 * machine-grouped view.
 */
import EventEmitter from "eventemitter3";
import type { HubRef, NodeInfo } from "@brain/sdk";
import type { IBusService } from "../bus/bus.interface";
import {
  NETWORK_SNAPSHOT_TOPIC,
  NETWORK_BYE_TOPIC,
  NETWORK_SNAPSHOT_DEFAULT_MS,
  type NetworkSnapshot,
  type NetworkBye,
} from "./protocol";

export interface NetworkDirectoryOptions {
  /** TTL for a hub's snapshot in ms; defaults to 3× the heartbeat. */
  ttlMs?: number;
  /** Expiry sweep cadence; defaults to ttlMs / 3. */
  sweepIntervalMs?: number;
}

export class NetworkDirectory extends EventEmitter {
  private readonly seen = new Map<string, NetworkSnapshot>();
  /**
   * Local-clock receipt time per hub. Expiry is measured against THIS, not
   * the snapshot's own `ts` — that `ts` is stamped on the *publisher's*
   * clock, and any skew between machines (a remote peer a few seconds
   * behind) would otherwise make every snapshot look instantly stale and
   * the peer would never render. Liveness = "did we hear from it recently",
   * which only our own clock can answer consistently.
   */
  private readonly lastSeen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * @param bus       shared bus.
   * @param selfHubId our own hub id — snapshots from it are ignored so we
   *                  never merge our own nodes back in as "remote".
   */
  constructor(
    private readonly bus: IBusService,
    private readonly selfHubId: string,
    opts: NetworkDirectoryOptions = {},
  ) {
    super();
    this.ttlMs = opts.ttlMs ?? NETWORK_SNAPSHOT_DEFAULT_MS * 3;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3));
  }

  /** Hook onto the bus and start the expiry sweep. Idempotent. */
  attach(): void {
    const apiId = "__brain.api.network__";
    this.bus.subscribe(apiId, NETWORK_SNAPSHOT_TOPIC);
    this.bus.subscribe(apiId, NETWORK_BYE_TOPIC);
    this.bus.on(`message:${apiId}`, (msg) => {
      const content = (msg.payload as { content?: string } | undefined)?.content;
      if (typeof content !== "string") return;
      if (msg.topic === NETWORK_BYE_TOPIC) { this.onBye(content); return; }
      this.onSnapshot(content);
    });

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  /** Stop the sweep timer. Call in tests / on graceful shutdown. */
  detach(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  private onSnapshot(content: string): void {
    let snap: NetworkSnapshot;
    try { snap = JSON.parse(content) as NetworkSnapshot; } catch { return; }
    if (!snap?.hub?.hub_id || !Array.isArray(snap.nodes)) return;
    if (snap.hub.hub_id === this.selfHubId) return; // never track self
    const isNew = !this.seen.has(snap.hub.hub_id);
    this.seen.set(snap.hub.hub_id, snap);
    this.lastSeen.set(snap.hub.hub_id, Date.now());
    if (isNew) this.emit("hub:added", snap.hub);
    this.emit("hub:snapshot", snap);
  }

  private onBye(content: string): void {
    let bye: NetworkBye;
    try { bye = JSON.parse(content) as NetworkBye; } catch { return; }
    if (!bye?.hub_id || bye.hub_id === this.selfHubId) return;
    const snap = this.seen.get(bye.hub_id);
    if (snap) { this.drop(bye.hub_id); this.emit("hub:expired", snap.hub); }
  }

  /** Live peer hubs, most-recently-seen first. Pruned by ttl. */
  hubs(): HubRef[] {
    this.sweepExpired();
    return Array.from(this.seen.keys())
      .sort((a, b) => (this.lastSeen.get(b) ?? 0) - (this.lastSeen.get(a) ?? 0))
      .map((id) => this.seen.get(id)!.hub);
  }

  /** Raw peer snapshots (hub + its nodes). Pruned by ttl. */
  list(): NetworkSnapshot[] {
    this.sweepExpired();
    return Array.from(this.seen.values());
  }

  /**
   * All remote nodes across every live peer, each stamped with its
   * `owner_hub`. Union this with the local `InstanceRegistry.list()` for
   * the full machine-grouped network view.
   */
  mergedNodes(): NodeInfo[] {
    this.sweepExpired();
    const out: NodeInfo[] = [];
    for (const snap of this.seen.values()) {
      for (const node of snap.nodes) {
        out.push({ ...node, owner_hub: snap.hub });
      }
    }
    return out;
  }

  private sweepExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, snap] of this.seen) {
      if ((this.lastSeen.get(id) ?? 0) < cutoff) {
        this.drop(id);
        this.emit("hub:expired", snap.hub);
      }
    }
  }

  private drop(hubId: string): void {
    this.seen.delete(hubId);
    this.lastSeen.delete(hubId);
  }
}
