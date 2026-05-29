import {
  type AuthorityLevel,
  type SubscriptionConfig,
  type TransportMode,
  type WebTransportConfig,
  type PortsConfig,
  type PortBindings,
} from "./types";

export interface NodeTypeConfig {
  name: string;
  description: string;
  tags: string[];
  default_authority: AuthorityLevel;
  default_priority: number;
  /** 2-layer wiring contract — MANDATORY. Each input port is exposed as an
   *  MCP tool and rendered as a typed, immutable port on the dashboard;
   *  each output port describes an RPC reply / fan-out channel.
   *  `default_port_bindings` seeds the per-instance topic↔port map for new
   *  spawns; the user can rewire at runtime via the live-wiring API
   *  (`POST/DELETE /nodes/:id/ports/:port/topics`). TypeRegistry.register
   *  REJECTS a config without both — there is no auto-derivation fallback. */
  ports: PortsConfig;
  default_port_bindings: PortBindings;
  /** DERIVED at registration from ports + default_port_bindings (the flat
   *  surface the bus, mailboxes, snapshot and live-wiring publishes API
   *  consume). Authors don't write these — never hand-maintain them. */
  default_subscriptions?: SubscriptionConfig[];
  default_publishes?: string[];
  has_ui?: boolean;
  interval?: string;
  supports_transport: TransportMode[];
  /** Required when the node ships with `transport: "web"` as its default. */
  web?: WebTransportConfig;
  origin?: "static" | "dynamic";
  created_by?: string;
  created_at?: string;
}

export interface NodeInstanceConfig {
  /**
   * Optional pre-allocated id. When the API dispatches a remote spawn
   * to an agent, both sides need the same id to track the same
   * instance — the API generates it and the agent honours it.
   * Undefined for normal local spawns; the lifecycle then generates one.
   */
  id?: string;
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  /** Same discriminated-union discipline as `default_subscriptions`. */
  subscriptions?: SubscriptionConfig[];
  priority?: number;
  ttl?: string;
  authority_level?: AuthorityLevel;
  transport?: TransportMode;
  /**
   * Required when `transport === "remote"`: the id of the brain-agent
   * that should host this node. The API publishes the spawn request
   * onto `brain.agents.<target_agent_id>.spawn`; the agent receives
   * it and runs the node locally.
   */
  target_agent_id?: string;
  position?: { x: number; y: number };
  config_overrides?: Record<string, unknown>;
  initial_message?: string;
}
