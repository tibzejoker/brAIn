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

/**
 * Where the node's executable lives.
 *
 * - `process` (default) — JS module loaded into the framework's own
 *   process via dynamic import. Lowest latency, no isolation.
 * - `container` — node ships a Dockerfile, the runner launches a
 *   container. Real isolation, language-agnostic. (Phase 5.)
 * - `web` — node is a remote HTTP/WS service the framework talks to
 *   over a long-lived WebSocket; any language with HTTP support can
 *   implement a node. Bearer-token auth supported.
 * - `remote` — node lives on a brain-agent instance reachable via the
 *   shared NATS bus. The API doesn't host a runner; instead it
 *   dispatches a spawn-request to the target agent, which creates the
 *   actual runner locally. The node's bus traffic transits NATS so
 *   every other instance still sees it. Requires `target_agent_id`.
 */
export type TransportMode = "process" | "container" | "web" | "remote";

/**
 * Web-transport configuration, only meaningful when `transport: "web"`.
 * Lives on `NodeTypeConfig.web` and may be overridden per-instance via
 * `config_overrides.web`.
 */
export interface WebTransportConfig {
  /** Base URL of the node's HTTP server. The runner connects to `${url}/brain/ws`. */
  url: string;
  /** Optional auth. The runner sends `Authorization: Bearer <token>` on the WS upgrade. */
  auth?: {
    type: "bearer";
    /** Env var name where the bearer token is read from. Avoids putting secrets in config files. */
    token_env: string;
  };
  /** Reconnect backoff bounds (ms). Defaults: 500 → 15_000. */
  reconnect_min_ms?: number;
  reconnect_max_ms?: number;
  /** Heartbeat ping interval. Default 20_000 ms. */
  ping_interval_ms?: number;
}
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
  /**
   * Causal trace identifier. All messages in the same logical
   * conversation share a `trace_id`. The bus auto-allocates one if
   * absent at publish time; replies / forwarded messages inherit from
   * their parent. Used by `GET /network/traces/:id` to walk the chain.
   */
  trace_id?: string;
  /**
   * The id of the message whose handler caused this one to be published,
   * if any. Set automatically by the runner when the handler calls
   * `ctx.publish` while processing a message; kept for direct calls
   * to `bus.publish` from system code.
   */
  parent_id?: string;
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
  /**
   * Set when `transport === "remote"`: the brain-agent currently hosting
   * this node. Used by the API to route control actions over NATS.
   */
  target_agent_id?: string;
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

  /**
   * Cancellation handle for the current handler iteration. The runner
   * aborts this signal when a higher-criticality message arrives
   * during execution, so any I/O the handler is waiting on (LLM call,
   * fetch, child-process spawn, …) can short-circuit and let the
   * runner re-invoke the handler with `wasPreempted = true` +
   * `preemptionContext`.
   *
   * Pass it to every long-lived async API the handler uses:
   *   await generateText({ ..., abortSignal: ctx.signal });
   *   spawn("claude", args, { signal: ctx.signal });
   *   await fetch(url, { signal: ctx.signal });
   */
  signal: AbortSignal;
}

// === Handler ===

export type NodeHandler = (ctx: NodeContext) => Promise<void>;

/**
 * Optional spawn hook called once when the node is started by the runner —
 * either at spawn time or when restored from the database. Mirror of
 * `NodeTeardown`. Use it to acquire process-level resources (e.g. boot a
 * child server) eagerly, before any message reaches the handler.
 *
 * Receives the spawned `NodeInfo` so the implementation can stash the
 * node id (needed to publish on the bus from background tasks like a
 * long-lived WebSocket bridge).
 *
 * Fire-and-forget from the runner's perspective. Failures are logged but
 * don't block the start flow; the handler can recover lazily on its first
 * invocation.
 */
export type NodeOnSpawn = (info: NodeInfo) => Promise<void> | void;

/**
 * Optional teardown hook called once when the node is killed or stopped.
 * Use it to release process-level resources the handler module owns
 * (child processes, open sockets, file watchers, etc.).
 *
 * Fire-and-forget from the runner's perspective — failures are logged
 * but don't block the kill flow.
 */
/**
 * Teardown hook. Called once when the node is killed or stopped.
 * The `info` argument is passed so handlers that maintain per-instance
 * state (e.g. an mcp-host with multiple nodes in the same process)
 * can clean up the right slot without a closure dance — read
 * `info.id`. Existing zero-arg implementations stay valid (TS allows
 * fewer parameters than declared).
 */
export type NodeTeardown = (info: NodeInfo) => Promise<void> | void;

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
