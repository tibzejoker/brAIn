/**
 * Publishes this hub's live registry on the network channel so peers can
 * render it. Counterpart to {@link NetworkDirectory} (the consumer) and a
 * sibling of agent-presence (which advertises *types*; this advertises
 * *running instances*).
 *
 * Emits a `NetworkSnapshot` on `brain.network.snapshot`:
 *   - immediately on start,
 *   - every `intervalMs` as a liveness heartbeat,
 *   - and on demand when the local registry changes (spawn/kill/state),
 *     coalesced through a short trailing debounce so a burst of spawns is
 *     one publish, not twenty.
 * On `stop()` it sends a `NetworkBye` so peers drop us without waiting for
 * the TTL sweep.
 *
 * The caller supplies `snapshot()` already filtered to nodes this hub
 * actually hosts (exclude `transport: "remote"` stubs — those belong to a
 * peer, which advertises them itself).
 */
import type EventEmitter from "eventemitter3";
import type { HubRef, NodeInfo } from "@brain/sdk";
import type { IBusService } from "../bus/bus.interface";
import {
  NETWORK_SNAPSHOT_TOPIC,
  NETWORK_BYE_TOPIC,
  NETWORK_SNAPSHOT_DEFAULT_MS,
  type NetworkSnapshot,
  type NetworkBye,
} from "./protocol";

const CHANGE_EVENTS = ["node:spawned", "node:killed", "node:state_changed"] as const;
const CHANGE_DEBOUNCE_MS = 100;

export interface NetworkPublisherOptions {
  bus: IBusService;
  /** Who we are — `buildHubRef(db, httpUrl)`. */
  hub: HubRef;
  /** Current nodes this hub hosts (caller filters out remote stubs). */
  snapshot: () => NodeInfo[];
  /** Emitter whose change events trigger an immediate (debounced)
   *  republish — pass the `BrainService` (fires the CHANGE_EVENTS). */
  changes?: EventEmitter;
  /** Heartbeat cadence; defaults to 3s. */
  intervalMs?: number;
}

export interface NetworkPublisherHandle {
  publishNow(): void;
  stop(): void;
}

export function startNetworkPublisher(opts: NetworkPublisherOptions): NetworkPublisherHandle {
  const { bus, hub, snapshot, changes } = opts;
  const intervalMs = opts.intervalMs ?? NETWORK_SNAPSHOT_DEFAULT_MS;

  const publishNow = (): void => {
    const snap: NetworkSnapshot = { hub, nodes: snapshot(), ts: Date.now() };
    bus.publish({
      from: `hub:${hub.hub_id}`,
      topic: NETWORK_SNAPSHOT_TOPIC,
      type: "text",
      criticality: 0,
      payload: { content: JSON.stringify(snap) },
    });
  };

  let debounce: NodeJS.Timeout | null = null;
  const onChange = (): void => {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = null; publishNow(); }, CHANGE_DEBOUNCE_MS);
    debounce.unref();
  };
  if (changes) for (const ev of CHANGE_EVENTS) changes.on(ev, onChange);

  publishNow();
  const timer = setInterval(publishNow, intervalMs);
  timer.unref();

  return {
    publishNow,
    stop(): void {
      clearInterval(timer);
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (changes) for (const ev of CHANGE_EVENTS) changes.off(ev, onChange);
      const bye: NetworkBye = { hub_id: hub.hub_id, ts: Date.now() };
      bus.publish({
        from: `hub:${hub.hub_id}`,
        topic: NETWORK_BYE_TOPIC,
        type: "text",
        criticality: 0,
        payload: { content: JSON.stringify(bye) },
      });
    },
  };
}
