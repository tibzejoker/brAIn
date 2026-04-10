import {
  type AuthorityLevel,
  type MailboxConfig,
  type TransportMode,
} from "./types";

export interface NodeTypeConfig {
  name: string;
  description: string;
  tags: string[];
  default_authority: AuthorityLevel;
  default_priority: number;
  default_subscriptions: Array<{
    topic: string;
    mailbox?: Partial<MailboxConfig>;
  }>;
  interval?: string;
  supports_transport: TransportMode[];
  origin?: "static" | "dynamic";
  created_by?: string;
  created_at?: string;
}

export interface NodeInstanceConfig {
  type: string;
  name: string;
  tags?: string[];
  subscriptions?: Array<{
    topic: string;
    mailbox?: Partial<MailboxConfig>;
  }>;
  priority?: number;
  ttl?: string;
  authority_level?: AuthorityLevel;
  transport?: TransportMode;
  position?: { x: number; y: number };
  config_overrides?: Record<string, unknown>;
  initial_message?: string;
}
