import type {
  NodeInfo,
  NodeState,
  Message,
  NodeTypeConfig,
  NodeInstanceConfig,
  SubscriptionConfig,
} from "@brain/sdk";

export type {
  NodeInfo,
  NodeState,
  Message,
  NodeTypeConfig,
  NodeInstanceConfig,
  SubscriptionConfig,
};

export interface SubscriptionSnapshot {
  id: string;
  pattern: string;
}

export interface NodeSnapshot extends Omit<NodeInfo, "subscriptions"> {
  subscriptions: SubscriptionSnapshot[];
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
