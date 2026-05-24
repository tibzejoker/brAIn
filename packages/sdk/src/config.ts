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
  /** Every entry is either a public tool (`{description, inputSchema}` both required)
   *  or marked `{internal: true}`. The discriminated union enforces this at compile
   *  time — config.json files that omit `inputSchema` without `internal:true` are
   *  rejected by the framework's TypeValidatorService at registration time.
   *
   *  Used for INTERNAL listeners (alerts.*, time.tick, etc.) and as the
   *  legacy single-layer wiring surface. When the node also declares
   *  {@link ports}, those become the PUBLIC contract (MCP tools, dashboard
   *  side panel ports section) and `default_subscriptions` is reserved for
   *  private plumbing. The framework auto-derives ports from any public
   *  entries here if `ports` is omitted, for backward compat. */
  default_subscriptions: SubscriptionConfig[];
  default_publishes?: string[];
  /** 2-layer wiring contract. When set, each input port is exposed as an
   *  MCP tool and rendered as a typed, immutable port on the dashboard.
   *  `default_port_bindings` seeds the per-instance topic↔port map for new
   *  spawns; the user can rewire at runtime via the live-wiring API
   *  (`POST/DELETE /nodes/:id/ports/:port/topics`). */
  ports?: PortsConfig;
  default_port_bindings?: PortBindings;
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
