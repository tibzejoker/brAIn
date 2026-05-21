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
