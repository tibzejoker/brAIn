import type { NodeInstanceConfig } from "./config";

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

/**
 * A bus subscription is either a "tool" (public API of the node — the
 * brain LLM and external MCP clients can discover + call it) or an
 * "internal listener" (private plumbing — observers, log sinks, fan-out
 * tees that aren't meant to be called as commands).
 *
 * Discriminated union so TypeScript catches *at compile time* nodes
 * that declare a public subscription without an `inputSchema`. The
 * framework's validator additionally rejects bad shapes at type-
 * registration time so JSON `config.json` files can't sneak past
 * either.
 */
export interface BaseSubscription {
  topic: string;
  /** Human-readable purpose. **Always required** — internal subs need
   *  it too because the dashboard and logs reference it. */
  description: string;
  min_criticality?: number;
  mailbox?: Partial<MailboxConfig>;
}

export interface PublicSubscriptionConfig extends BaseSubscription {
  /** Marker — distinguishes from `InternalSubscriptionConfig`. Setting
   *  `internal: false` explicitly is fine but typically omitted. */
  internal?: false;
  /** JSON Schema describing the expected payload. **Required.** The
   *  framework validates messages against this at publish time and
   *  surfaces it via `/tools` so the brain LLM can use the topic as
   *  a discovered tool. There is no "permissive default" anymore —
   *  if your payload is genuinely unstructured, declare an empty
   *  object schema explicitly: `{ type: "object" }`. */
  inputSchema: Record<string, unknown>;
  /**
   * **Optional** — declares this subscription as RPC-shaped, with a
   * structured response. When present, the framework:
   *   - surfaces it through `/mcp` as the tool's `outputSchema`, so
   *     external MCP clients (Claude Desktop, Cursor, …) know what
   *     to expect back from a call;
   *   - lets the dashboard render a paired output handle on the side
   *     panel so wiring "result of A → B" is visible.
   * When absent (the default), the subscription stays purely event-
   * driven — the handler can publish anything (or nothing) on any
   * topic afterwards. brAIn's bus is ambient first, RPC by opt-in.
   */
  outputSchema?: Record<string, unknown>;
}

export interface InternalSubscriptionConfig extends BaseSubscription {
  /** Hides this sub from `/tools`, the MCPBridge, and publish-time
   *  validation. Use sparingly — only for observe-only / fan-in
   *  listeners that aren't a node's public API surface. */
  internal: true;
  /** Allowed but not required on internal subs. */
  inputSchema?: Record<string, unknown>;
  /** Internal subs can opt into the RPC shape too (e.g. a private
   *  helper that returns a value via reply_to). Same semantics as
   *  the public version, just not exposed via /mcp. */
  outputSchema?: Record<string, unknown>;
}

export type SubscriptionConfig = PublicSubscriptionConfig | InternalSubscriptionConfig;

/** Narrow a `SubscriptionConfig` to its public form for callers that
 *  filter out internal listeners (the MCPBridge, `/tools` discovery). */
export function isPublicSubscription(s: SubscriptionConfig): s is PublicSubscriptionConfig {
  return s.internal !== true;
}

/** Coerce a raw subscription record (e.g. parsed from a config.json or
 *  a DB row) into the typed discriminated union. If `inputSchema` is
 *  missing the sub is forced to `internal: true` — the framework's
 *  validator is responsible for refusing un-migrated configs upstream;
 *  this helper just makes downstream framework code (lifecycle, restore,
 *  remote dispatch) compile against the strict types. */
export function normaliseSubscription(raw: {
  topic: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  min_criticality?: number;
  mailbox?: Partial<MailboxConfig>;
  internal?: boolean;
}): SubscriptionConfig {
  const base = {
    topic: raw.topic,
    description: raw.description ?? raw.topic,
    min_criticality: raw.min_criticality,
    mailbox: raw.mailbox,
  };
  if (raw.internal === true || !raw.inputSchema) {
    return { ...base, internal: true, inputSchema: raw.inputSchema };
  }
  return { ...base, inputSchema: raw.inputSchema };
}

// === Network / hubs ===

/**
 * Identifies the machine ("hub") a node belongs to in a peer-to-peer
 * network. brAIn instances joined to the same NATS bus are symmetric
 * peers — there is no master/slave; each hub publishes its own running
 * registry and consumes the others'. `owner_hub` on a `NodeInfo` is the
 * routing key any client (the React dashboard, a future Flutter app, …)
 * uses to decide *which* HTTP origin serves that node's UI and accepts
 * spawn/kill for it, and which `brain.agents.<hub_id>.*` control topic
 * targets it over the bus.
 *
 * `hub_id` is the stable per-install id (same value as the agent-presence
 * `agent_id`), so the snapshot channel and the control channel correlate.
 */
export interface HubRef {
  hub_id: string;
  hub_label: string;
  /** Best-guess reachable HTTP base (first of `http_urls`). Kept for the
   *  join URI `&api=` and older peers. Prefer probing `http_urls`. */
  http_url?: string;
  /** ALL candidate HTTP bases for this hub — one per network interface
   *  (e.g. `["http://192.168.1.19:3000", "http://10.5.0.2:3000"]`). A hub
   *  can't know which of its interfaces a given peer can reach (LAN vs a
   *  VPN/WSL/Docker adapter), so it advertises them all and each consumer
   *  probes for the first that answers — like ICE candidates. */
  http_urls?: string[];
  /** Where this hub's container sits on the shared canvas. Each hub owns
   *  + persists its own block position and broadcasts it, so every viewer
   *  places the machine's box in the same spot. Absent until first moved. */
  canvas_pos?: { x: number; y: number };
  /** Whether THIS hub is currently running its own NATS broker
   *  (`embedded` → the would-be host) or has joined someone else's
   *  (`external` → client/joiner). Dashboards use it to badge hosts vs
   *  clients in the merged network view. Absent on old peers — treat
   *  missing as "unknown" rather than defaulting either way. */
  broker_mode?: "embedded" | "external";
}

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
  /**
   * The hub (machine) that physically runs this node and serves its UI.
   * Stamped by `NetworkDirectory` when merging a peer's snapshot; left
   * undefined for purely-local nodes on a standalone instance (callers
   * treat "undefined" as "mine / same origin"). See {@link HubRef}.
   */
  owner_hub?: HubRef;
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

/**
 * Facade for any LLM operation a node wants to perform. Implementations
 * live in @brain/core; nodes never reach for `ai-sdk` / `LLMRegistry`
 * directly — that's what this interface is for.
 *
 * Resolution rules: `model` (per-call) > node `config_overrides.model` >
 * project-wide global default > framework fallback chain. The first
 * candidate whose provider is currently reachable wins. Every call
 * automatically emits an `llm.usage` event with attribution.
 */
export interface LLMTextOptions {
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  model?: string;
  fallback?: string[];
  maxTokens?: number;
  /** Strip `<think>` / `<thinking>` blocks from the answer. Default true. */
  stripReasoning?: boolean;
  /** Override the abort signal for this call. Defaults to `ctx.signal`
   *  which lives for one handler iteration — pass a fresh signal here
   *  if the call fires from a background task that outlives the
   *  current iteration. */
  signal?: AbortSignal;
}

export interface LLMResolutionTrace {
  requested: string;
  resolved: string;
  layer: "node-override" | "global-default" | "fallback" | "explicit";
  fell_back: boolean;
  fallback_reason?: string;
}

/**
 * Schema-shape discipline (applies everywhere `inputSchema` is taken):
 *
 *   ✅ Flat object schemas with `type`, `properties`, `required`,
 *      `additionalProperties`, and `enum` lists.
 *   ❌ `oneOf` / `anyOf` discriminated unions — local LLMs (Gemma,
 *      smaller Llamas) handle these unreliably. If you need branching
 *      between several actions, use `ctx.llm.tools({tools: {...}})`
 *      below and let ai-sdk + the model pick a tool natively. One
 *      tool = one flat shape.
 *
 * The framework logs a warning when it sees `oneOf` / `anyOf` in a
 * passed inputSchema. Treat it as an antipattern outside of niche
 * cases (e.g. typed unions with capable hosted models only).
 */
export interface LLMToolOptions<Args> {
  /** The tool the model is forced to invoke. `inputSchema` is either a
   *  zod schema OR a flat JSON Schema (no oneOf — see discipline note
   *  above the type). The resolved args are returned typed. */
  tool: {
    name: string;
    description: string;
    inputSchema: unknown;
  };
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  model?: string;
  fallback?: string[];
  maxTokens?: number;
  /** Retry once with a stricter "you MUST call the tool" system prompt
   *  if the model emits text without a tool call. Default 1. */
  retries?: number;
  /** Optional callback to inspect the raw ai-sdk result before we
   *  return the input. Useful for telemetry / debugging. */
  onResult?: (result: unknown) => void;
  /** Marker only — when set, the return type narrows via `Args`. */
  _argsType?: Args;
}

// === Tool discovery (network-wide catalog) ===

export interface ToolDescriptor {
  /** The node currently exposing this tool. */
  node_id: string;
  /** Node's type (e.g. "hangman", "memory"). */
  node_type: string;
  /** Node's display name (instance-specific). */
  node_name: string;
  /** Bus topic the tool is invoked on. */
  topic: string;
  /** Human-readable purpose. */
  description: string;
  /** JSON Schema describing accepted payload. */
  inputSchema: Record<string, unknown>;
}

export interface ToolsFacade {
  /** Returns every public (non-internal) subscription currently
   *  exposed on the network, in MCP-tool-compatible shape. Refreshes
   *  each call — picks up newly-spawned nodes immediately. */
  list(): ToolDescriptor[];
  /** Filter to a single node — for hierarchical drill-down by external
   *  MCP clients or by `ctx.llm.agent` when scoping its tool catalog. */
  listForNode(nodeId: string): ToolDescriptor[];
}

export interface LLMMultiToolOptions {
  /** The set of tools the model can pick from. Each entry has its own
   *  flat inputSchema (see the discipline note on `LLMToolOptions`).
   *  Use this — NOT a single `tool()` call with `oneOf` — whenever
   *  the model needs to branch between distinct actions. */
  tools: Record<string, {
    description: string;
    inputSchema: unknown;
  }>;
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  model?: string;
  fallback?: string[];
  maxTokens?: number;
  /** Default "required": the model MUST call exactly one of the tools.
   *  "auto" lets it answer in plain text if it wants — handy for chat
   *  flows where a tool call is optional. */
  toolChoice?: "required" | "auto";
  retries?: number;
  signal?: AbortSignal;
  /** Default `true`: the framework auto-injects a zero-arg `stop` tool
   *  into the catalog as a canonical "nothing more to do" escape. Under
   *  the default `toolChoice: "required"` this is what lets the LLM end
   *  a wake without fabricating a noisy fake action. Detect it on the
   *  result via `picked.toolName === "stop"` and exit your step loop.
   *  Pass `false` only if you have a genuine reason to forbid early
   *  termination (and don't name one of your own tools `stop`). */
  allowStop?: boolean;
}

export interface LLMMultiToolResult {
  /** Which tool the model picked. Matches a key from `opts.tools` — or
   *  the literal string `"stop"` when the framework-injected escape
   *  tool fired (unless `allowStop: false`). On `"stop"`, `args` is `{}`
   *  and the caller should exit its step loop. */
  toolName: string;
  /** Validated args for the picked tool. Typed as `unknown` because
   *  the shape varies per tool — caller narrows by `toolName`. */
  args: Record<string, unknown>;
}

export interface LLMAgentOptions {
  /** The task / prompt handed to the CLI agent. A message array is
   *  flattened to a single prompt string (CLIs take one prompt). */
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Prepended as guidance ahead of the prompt. */
  system?: string;
  /** Which CLI agent to run ("claude" | "codex" | "gemini" | …). Defaults
   *  to the node's `config_overrides.cli`. Throws if neither is set. */
  cli?: string;
  /** Working directory for the agent. Defaults to the node's dataDir, so
   *  file ops stay sandboxed to the node — the brAIn isolation model. */
  cwd?: string;
  /** Wall-clock cap (ms). Default 120_000. */
  timeoutMs?: number;
  /** Override the abort signal — defaults to `ctx.signal`. */
  signal?: AbortSignal;
}

export interface LLMAgentResult {
  /** The agent's final answer, extracted from its output envelope. */
  text: string;
  /** Which CLI produced it. */
  cli: string;
  /** Raw stdout, for debugging an unexpected envelope. */
  raw: string;
}

export interface LLMFacade {
  /** Plain text generation. Returns the extracted answer. */
  text(opts: LLMTextOptions): Promise<string>;
  /** Delegate a task to an installed agentic CLI (claude-code, codex,
   *  gemini). The CLI runs its OWN tool loop; brAIn hands it a prompt,
   *  a sandboxed cwd and a deadline, then returns its answer. Routed by
   *  `opts.cli` → node's `config_overrides.cli`. Emits a `cli` usage
   *  event. Throws if no CLI is selected or the selected one isn't
   *  installed. */
  agent(opts: LLMAgentOptions): Promise<LLMAgentResult>;
  /** Forced tool call — the model MUST emit a structured `inputSchema`-
   *  validated object. No client-side JSON parsing needed; the ai-sdk
   *  schema-validates the result. Returns the tool args. Throws if every
   *  provider in the chain fails to produce a valid call.
   *
   *  For multi-action branching, prefer `tools()` instead — that hits
   *  ai-sdk's native multi-tool path and works reliably with local
   *  models, where a single tool with `oneOf` does not. */
  tool<Args = Record<string, unknown>>(opts: LLMToolOptions<Args>): Promise<Args>;
  /** Multi-tool dispatch: the model picks ONE tool from the supplied
   *  map. Same failover semantics as `tool()`. Returns `{toolName,
   *  args}`. This is the right shape for "let the LLM choose between
   *  several distinct actions" — replaces the `tool()` + `oneOf`
   *  antipattern. */
  tools(opts: LLMMultiToolOptions): Promise<LLMMultiToolResult>;
  /** Resolution-only — returns what model this node would use without
   *  making a call. Powers dashboard previews. */
  resolveModel(explicit?: string, fallbackOverride?: string[]): LLMResolutionTrace;
  /** Currently-reachable models, grouped by provider. UI-friendly. */
  listModels(): Array<{ spec: string; provider: string; model: string }>;
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
  /**
   * Add a runtime subscription. Two call shapes, mirroring the static
   * `default_subscriptions` discipline — the framework refuses an
   * incomplete public declaration so nothing can sneak into the
   * network without a schema.
   *
   *  - Public tool: `{ description, inputSchema }` both required. The
   *    subscription is appended to `nodeInfo.subscriptions`, surfaced
   *    via `/tools`, and validated on publish.
   *  - Internal listener: `{ internal: true, description? }`. No schema
   *    needed; the sub is private plumbing (observers, fan-in tees).
   */
  subscribe(
    topic: string,
    opts?:
      | { description: string; inputSchema: Record<string, unknown>; mailbox?: Partial<MailboxConfig>; internal?: false }
      | { internal: true; description?: string; mailbox?: Partial<MailboxConfig> },
  ): void;
  unsubscribe(topic: string): void;

  // Lifecycle
  /**
   * Spawn a new node. Requires the caller to have at least ELEVATED
   * authority — the AuthorityService check on the lifecycle path
   * enforces this and caps the child's authority at one level below
   * the caller. Throws if BrainService is not available (e.g. during
   * isolated tests with a stubbed runner).
   */
  spawn(config: NodeInstanceConfig): Promise<NodeInfo>;

  /**
   * Kill a node by id. Requires ELEVATED+ authority and the target
   * must have strictly lower authority than the caller. Returns false
   * if the node doesn't exist; throws on permission denial.
   */
  kill(nodeId: string, reason?: string): boolean;

  // LLM (optional)
  callLLM(opts: LLMRequest): Promise<LLMResponse>;

  /**
   * Per-node LLM facade. Always present — even on runners that don't
   * have an LLMRegistry wired (in which case calls throw a clear error
   * pointing at the missing dep). Prefer this over `callLLM` for new
   * code; `callLLM` is kept for backward compatibility but stubbed.
   */
  llm: LLMFacade;

  /**
   * Network-wide tool catalog — every public subscription currently
   * exposed by any node. Use this when wiring `ctx.llm.agent({tools})`
   * so the LLM sees every callable command on the bus without you
   * having to maintain a separate list. Internal subs are filtered out.
   */
  tools: ToolsFacade;

  // External tools / MCP
  callTool(server: string, tool: string, params: unknown): Promise<unknown>;

  // Shared files
  readFile(id: string): Promise<FileContent>;
  writeFile(name: string, content: string, opts?: FileOpts): Promise<FileRef>;
  listFiles(filter?: FileFilter): Promise<FileInfo[]>;

  // Persistent local state between iterations
  state: Record<string, unknown>;

  /**
   * Absolute path to a directory the framework reserved for this
   * node's persistent files (DBs, blobs, logs, anything you want to
   * survive a respawn). The directory is created on first read of
   * this property — so just opening a SQLite file at
   * `path.join(ctx.dataDir, "store.db")` Just Works.
   *
   * Each node owns its dataDir exclusively. Don't read or write
   * inside another node's dataDir; cross-node data must flow over
   * the bus.
   */
  dataDir: string;

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
