import {
  type AuthorityLevel,
  type MailboxConfig,
  type TransportMode,
  type WebTransportConfig,
} from "./types";

export interface NodeTypeConfig {
  name: string;
  description: string;
  tags: string[];
  default_authority: AuthorityLevel;
  default_priority: number;
  default_subscriptions: Array<{
    topic: string;
    /**
     * Required: what this topic does, used as MCP tool description
     * and surfaced in the dashboard.
     */
    description: string;
    /** Optional JSON Schema for the payload; defaults to open object. */
    inputSchema?: Record<string, unknown>;
    mailbox?: Partial<MailboxConfig>;
  }>;
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
  subscriptions?: Array<{
    topic: string;
    /** Required when overriding subscriptions at instance level too. */
    description: string;
    inputSchema?: Record<string, unknown>;
    mailbox?: Partial<MailboxConfig>;
  }>;
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
