// === Enums ===

export enum NodeState {
  ACTIVE = "active",
  SLEEPING = "sleeping",
  STOPPED = "stopped",
  TERMINATED = "terminated",
}

export enum AuthorityLevel {
  BASIC = 0,
  ELEVATED = 1,
  ROOT = 2,
}

export type TransportMode = "process" | "container";
export type RunMode = "auto" | "manual";

// === Messages ===

export interface TextPayload {
  content: string;
}

export interface FilePayload {
  file_id: string;
  filename: string;
  mime_type: string;
  size: number;
  description?: string;
}

export interface AlertPayload {
  title: string;
  description: string;
  source_context?: string;
  suggested_action?: string;
  requires_ack?: boolean;
}

export type MessageType = "text" | "file" | "alert";
export type Payload = TextPayload | FilePayload | AlertPayload;

export interface Message {
  id: string;
  from: string;
  topic: string;
  type: MessageType;
  criticality: number;
  payload: Payload;
  timestamp: number;
  reply_to?: string;
  ttl?: number;
  metadata?: Record<string, unknown>;
}

// === Mailbox ===

export type RetentionPolicy = "latest" | "lowest_priority";

export interface MailboxConfig {
  max_size: number;
  retention: RetentionPolicy;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {
  max_size: 100,
  retention: "latest",
};

// === Subscriptions ===

export interface SubscriptionConfig {
  topic: string;
  min_criticality?: number;
  mailbox?: Partial<MailboxConfig>;
}

// === Wake conditions ===

export type WakeCondition =
  | { type: "topic"; value: string; min_criticality?: number }
  | { type: "timer"; value: string }
  | { type: "any" };

// === Node info ===

export interface NodeInfo {
  id: string;
  type: string;
  name: string;
  description: string;
  tags: string[];
  authority_level: AuthorityLevel;
  state: NodeState;
  priority: number;
  subscriptions: SubscriptionConfig[];
  transport: TransportMode;
  position: { x: number; y: number };
  config_overrides?: Record<string, unknown>;
  default_publishes?: string[];
  spawned_by?: string;
  ttl?: number;
  created_at: number;
}

// === Preemption ===

export interface PreemptionContext {
  partial_response?: string;
  executed_tools?: Array<{ tool: string; params: unknown; result: unknown }>;
  interrupting_message: Message;
  previous_messages: Message[];
}

// === Read messages options ===

export interface ReadMessagesOptions {
  topic?: string;
  limit?: number;
  mode?: "unread" | "latest" | "all";
  min_criticality?: number;
  peek?: boolean;
}

// === LLM ===

export interface LLMRequest {
  model?: string;
  system?: string;
  messages?: unknown[];
  tools?: unknown[];
}

export interface LLMResponse {
  content: string;
  tool_calls?: Array<{ tool: string; params: unknown }>;
}

// === Files ===

export interface FileOpts {
  mime_type?: string;
  description?: string;
}

export interface FileRef {
  file_id: string;
  filename: string;
  size: number;
}

export interface FileContent {
  content: string;
  filename: string;
  mime_type: string;
  metadata: Record<string, unknown>;
}

export interface FileFilter {
  created_by?: string;
  mime_type?: string;
  filename_pattern?: string;
}

export interface FileInfo {
  file_id: string;
  filename: string;
  mime_type: string;
  size: number;
  created_by: string;
  created_at: number;
}

// === Node Context ===

export interface NodeContext {
  // Messages
  messages: Message[];
  readMessages(opts?: ReadMessagesOptions): Message[];

  // Communication
  /** Publish to the node's configured response_topic. Preferred for service nodes. */
  respond(content: string, metadata?: Record<string, unknown>): void;
  /** Publish to a specific topic. Use respond() unless you need explicit routing. */
  publish(topic: string, message: Omit<Message, "id" | "from" | "timestamp" | "topic">): void;
  subscribe(topic: string, mailbox?: Partial<MailboxConfig>): void;
  unsubscribe(topic: string): void;

  // Lifecycle
  sleep(conditions: WakeCondition[]): void;

  // LLM (optional)
  callLLM(opts: LLMRequest): Promise<LLMResponse>;

  // External tools / MCP
  callTool(server: string, tool: string, params: unknown): Promise<unknown>;

  // Shared files
  readFile(id: string): Promise<FileContent>;
  writeFile(name: string, content: string, opts?: FileOpts): Promise<FileRef>;
  listFiles(filter?: FileFilter): Promise<FileInfo[]>;

  // Persistent local state between iterations
  state: Record<string, unknown>;

  // Logging — writes to per-node log buffer (visible in dashboard)
  log(level: "info" | "warn" | "error" | "debug", message: string, data?: Record<string, unknown>): void;

  // Metadata
  node: NodeInfo;
  iteration: number;
  wasPreempted: boolean;
  preemptionContext?: PreemptionContext;
}

// === Handler ===

export type NodeHandler = (ctx: NodeContext) => Promise<void>;

/**
 * Optional spawn hook called once when the node is started by the runner —
 * either at spawn time or when restored from the database. Mirror of
 * `NodeTeardown`. Use it to acquire process-level resources (e.g. boot a
 * child server) eagerly, before any message reaches the handler.
 *
 * Fire-and-forget from the runner's perspective. Failures are logged but
 * don't block the start flow; the handler can recover lazily on its first
 * invocation.
 */
export type NodeOnSpawn = () => Promise<void> | void;

/**
 * Optional teardown hook called once when the node is killed or stopped.
 * Use it to release process-level resources the handler module owns
 * (child processes, open sockets, file watchers, etc.).
 *
 * Fire-and-forget from the runner's perspective — failures are logged
 * but don't block the kill flow.
 */
export type NodeTeardown = () => Promise<void> | void;

/**
 * Shape a node module is allowed to export. The dynamic loader accepts
 * either a bare `NodeHandler` (legacy single-export style) or this object
 * form when lifecycle hooks are needed.
 */
export interface NodeModule {
  handler: NodeHandler;
  onSpawn?: NodeOnSpawn;
  teardown?: NodeTeardown;
}
