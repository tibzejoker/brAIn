/**
 * Wire protocol for the peer-to-peer network channel.
 *
 * brAIn instances joined to the same NATS bus are symmetric peers. Each
 * one periodically publishes a `NetworkSnapshot` of its *running* registry
 * on a single well-known topic; every peer's `NetworkDirectory` consumes
 * the topic and assembles a merged, owner-tagged view. This is the
 * client-agnostic contract: the React dashboard, a future Flutter app, or
 * any tool that speaks NATS can subscribe to `brain.network.snapshot` and
 * render the whole network in real time — nothing here is React-specific.
 *
 * Distinct from `brain.agents.discover` (agent-presence), which advertises
 * *installable types* + a control channel. The snapshot channel carries
 * *live node instances*. The two correlate via a shared id: a hub's
 * `hub_id` equals its agent-presence `agent_id`, so a client that sees a
 * remote node knows both its HTTP origin (`hub.http_url`) and its bus
 * control topic (`brain.agents.<hub_id>.spawn`).
 */
import type { HubRef, NodeInfo } from "@brain/sdk";

/** Topic every peer publishes its running registry on. */
export const NETWORK_SNAPSHOT_TOPIC = "brain.network.snapshot";

/** Topic a peer publishes once on graceful shutdown so others drop it
 *  immediately instead of waiting for the TTL sweep. */
export const NETWORK_BYE_TOPIC = "brain.network.bye";

/**
 * Live, shared node layout. Anyone can drag any node (local or a peer's);
 * the move is broadcast here (throttled ~10/s during a drag) so every view
 * updates in real time, and the node's OWNER hub persists it so it survives
 * reload/restart. Position is RELATIVE to the node's host container.
 */
export const NETWORK_LAYOUT_TOPIC = "brain.network.layout";

/** Ephemeral presence — each client's pointer in graph coordinates,
 *  throttled ~10/s. Consumers render + smooth (interpolate) and expire it. */
export const NETWORK_CURSOR_TOPIC = "brain.network.cursor";

/** Default heartbeat between snapshots. Peers also publish on demand
 *  (spawn/kill/state change), so this is a liveness floor, not the only
 *  source of updates. */
export const NETWORK_SNAPSHOT_DEFAULT_MS = 3_000;

/**
 * One peer's view of itself: who it is + every node it currently runs.
 * `nodes` is the raw local registry; receivers stamp each entry's
 * `owner_hub` with `hub` as they merge (the publisher leaves it unset to
 * keep the payload small and avoid self-referential duplication).
 */
export interface NetworkSnapshot {
  hub: HubRef;
  nodes: NodeInfo[];
  /** Wall-clock ms — receivers expire stale hubs past their TTL. */
  ts: number;
}

/** Sent on `NETWORK_BYE_TOPIC` for prompt removal on clean shutdown. */
export interface NetworkBye {
  hub_id: string;
  ts: number;
}

/** A node moved — broadcast on `NETWORK_LAYOUT_TOPIC`. `x`/`y` are relative
 *  to the node's host container. `by` is the hub that moved it (for the
 *  anti-echo on the originator's own dashboard). */
export interface LayoutUpdate {
  node_id: string;
  x: number;
  y: number;
  by: string;
  ts: number;
}

/** A client's pointer position — broadcast on `NETWORK_CURSOR_TOPIC`.
 *  `x`/`y` are React Flow graph coordinates so every view maps them the
 *  same way regardless of pan/zoom. */
export interface CursorUpdate {
  hub_id: string;
  label: string;
  x: number;
  y: number;
  ts: number;
}
