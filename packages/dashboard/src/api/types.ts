import type {
  NodeInfo,
  NodeState,
  Message,
  NodeTypeConfig,
  NodeInstanceConfig,
  SubscriptionConfig,
  HubRef,
} from "@brain/sdk";

export type {
  NodeInfo,
  NodeState,
  Message,
  NodeTypeConfig,
  NodeInstanceConfig,
  SubscriptionConfig,
  HubRef,
};

export interface SubscriptionSnapshot {
  id: string;
  pattern: string;
  /** True when the subscription was declared `internal: true` in the
   *  node's config — code-managed plumbing (alerts, time.tick, internal
   *  signals). The dashboard locks ✕ on these so the user can't break
   *  the node by deleting a sub the handler relies on. */
  internal: boolean;
  /** Carried so the dashboard can detect "[port:<name>]" descriptions and
   *  hide port-derived subs from the legacy Subscriptions list (they're
   *  rendered through the Ports section instead). */
  description?: string;
}

export interface NodeSnapshot extends Omit<NodeInfo, "subscriptions"> {
  subscriptions: SubscriptionSnapshot[];
  unread_count?: number;
}

export interface NetworkSnapshot {
  node_count: number;
  nodes: NodeSnapshot[];
}

export interface StateChangeEvent {
  nodeId: string;
  from: NodeState;
  to: NodeState;
}

export interface KillEvent {
  nodeId: string;
  reason?: string;
}

/** A peer hub's live registry arriving/refreshing on the network channel. */
export interface HubSnapshotEvent {
  hub: HubRef;
  nodes: NodeSnapshot[];
}

/** A peer hub gone silent / disconnected — drop all its nodes. */
export interface HubExpiredEvent {
  hub_id: string;
}

/** Live shared layout: a node moved (position relative to its host). */
export interface LayoutUpdate {
  node_id: string;
  x: number;
  y: number;
  by: string;
  ts: number;
}

/** Presence: another client's pointer in graph coordinates. */
export interface CursorUpdate {
  hub_id: string;
  /** Per-connection id (Socket.IO socket id). Lets two dashboards on
   *  the same hub be told apart — without it they collide on one key. */
  client_id?: string;
  label: string;
  x: number;
  y: number;
  ts: number;
}

/** A machine's container block moved on the shared canvas. */
export interface HostLayoutUpdate {
  hub_id: string;
  x: number;
  y: number;
  by: string;
  ts: number;
}
