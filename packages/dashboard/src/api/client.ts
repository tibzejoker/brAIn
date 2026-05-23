import type {
  NetworkSnapshot,
  NodeSnapshot,
  NodeTypeConfig,
  NodeInstanceConfig,
  Message,
} from "./types";
import { request } from "./request";

/**
 * Surface the bus broker info. The framework always runs on NATS;
 * `mode` says whether the API spawned an embedded broker for this
 * single-host setup or joined an external one (BRAIN_NATS_URL set
 * by the user). `bind_address` is the persisted preference flipped
 * by `setTransportBind`. `lan_ips` is this host's non-loopback
 * IPv4 addresses for building a routable URL.
 */
export interface TransportInfo {
  url: string | null;
  mode: "embedded" | "external";
  bind_address: string;
  lan_ips: string[];
  /** NATS auth token enforced by the embedded broker (null in external mode). */
  token: string | null;
  /** This hub's id — used to filter our own presence cursor out of the view. */
  hub_id: string;
  /** Our own container position on the shared canvas (null until moved). */
  canvas_pos: { x: number; y: number } | null;
  /** Our own externally-reachable HTTP base (best guess, first of
   *  `http_urls`) — used by the invite URI `&api=`. */
  http_url: string | null;
  /** All candidate HTTP bases (one per interface) for peers to probe. */
  http_urls: string[];
  /** When the API joined a remote hub via the persistent external-broker
   *  config (UI flow, not env), surface the URL + label + HTTP base so the
   *  dashboard can show "Connected to <hub>", load its node UIs, and offer
   *  Disconnect. Null in embedded mode or when external came from
   *  BRAIN_NATS_URL env. */
  joined_hub: { url: string; hubName?: string; http_url?: string } | null;
}
export function getTransport(): Promise<TransportInfo> {
  return request("/network/transport");
}

/**
 * Flip the persisted broker bind preference and trigger an API
 * restart so the new bind takes effect. Caller should poll
 * `getTransport()` until the new `bind_address` shows up.
 * `open: true` → bind 0.0.0.0 (LAN), `open: false` → bind 127.0.0.1.
 */
export function setTransportBind(open: boolean): Promise<{ bind_address: string; restart_scheduled: boolean }> {
  return request("/network/transport/bind", {
    method: "POST",
    body: JSON.stringify({ open }),
  });
}

/**
 * Join an existing brAIn hub by pointing the local API at its NATS
 * broker. Writes data/external-broker.json + exits(0) so the supervisor
 * restarts the API in `external` mode. Poll getTransport() until
 * mode === "external" to know the join landed.
 */
export function joinExternalBroker(
  url: string, token?: string, hubName?: string, httpUrl?: string,
): Promise<{ joined: boolean; restart_scheduled: boolean; url?: string }> {
  return request("/network/transport/external", {
    method: "POST",
    body: JSON.stringify({ url, token, hubName, httpUrl }),
  });
}

/** Drop the persisted external-broker config and restart in embedded mode. */
export function leaveExternalBroker(): Promise<{ left: boolean; restart_scheduled: boolean }> {
  return request("/network/transport/external", { method: "DELETE" });
}

// Store / marketplace endpoints — re-exported for back-compat with
// callers that already imported from ./client.
export {
  getStoreNodes, installFromStore, getStoreCandidates,
  refreshStore, getStoreUpstreamStatus, getInstalledUpdates,
} from "./store";
export type {
  StoreNodeStatus, StoreInstallResult, StoreCandidate, InstalledNodeUpdate,
} from "./store";

export function getNetwork(): Promise<NetworkSnapshot> {
  return request("/network");
}

export function getNode(id: string): Promise<NodeSnapshot> {
  return request(`/nodes/${id}`);
}

export function getTypes(): Promise<NodeTypeConfig[]> {
  return request("/types");
}

export function getMessages(opts?: {
  last?: number;
  topic?: string;
  min_criticality?: number;
  /** Comma-separated topic patterns to drop (trailing `*` = prefix). */
  exclude?: string;
}): Promise<Message[]> {
  const params = new URLSearchParams();
  if (opts?.last !== undefined) params.set("last", String(opts.last));
  if (opts?.topic) params.set("topic", opts.topic);
  if (opts?.min_criticality !== undefined)
    params.set("min_criticality", String(opts.min_criticality));
  if (opts?.exclude) params.set("exclude", opts.exclude);
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";
  return request(`/network/messages${suffix}`);
}

export function getTrace(traceId: string): Promise<Message[]> {
  return request(`/network/traces/${encodeURIComponent(traceId)}`);
}

export function replayTrace(
  traceId: string,
  intervalMs?: number,
): Promise<{ replayed: number; new_trace_id: string }> {
  const qs = intervalMs !== undefined ? `?interval_ms=${intervalMs}` : "";
  return request(`/network/traces/${encodeURIComponent(traceId)}/replay${qs}`, {
    method: "POST",
  });
}

export function spawnNode(config: NodeInstanceConfig): Promise<NodeSnapshot> {
  return request("/nodes", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function killNode(
  id: string,
  reason?: string,
): Promise<{ killed: boolean; node_id: string }> {
  return request(`/nodes/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

export function stopNode(
  id: string,
  reason?: string,
): Promise<{ stopped: boolean; node_id: string }> {
  return request(`/nodes/${id}/stop`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function startNode(
  id: string,
  message?: string,
): Promise<{ started: boolean; node_id: string }> {
  return request(`/nodes/${id}/start`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

// === Node position ===

export function updateNodePosition(
  id: string,
  x: number,
  y: number,
): Promise<{ updated: boolean; node_id: string }> {
  return request(`/nodes/${id}/position`, {
    method: "PATCH",
    body: JSON.stringify({ x, y }),
  });
}

// === Node config overrides ===

export function patchNodeConfig(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ updated: boolean; config_overrides: Record<string, unknown> }> {
  return request(`/nodes/${id}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * Publish a message into a node from the dashboard. Routes through
 * `/node/:id/:topic` which the framework proxies over NATS to the
 * node's owner hub, so a remote node is just as reachable as a local
 * one. `body` is forwarded verbatim as the message content.
 */
export function sendToNode(
  id: string,
  topic: string,
  body: unknown,
): Promise<{ message_id: string }> {
  return request(`/node/${id}/${topic}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// === Seeds ===

export interface SeedValidationError {
  line?: number;
  message: string;
}

export type SeedSource = "store" | "personal" | "root";

export interface SeedInfo {
  name: string;
  filename: string;
  valid: boolean;
  errors: SeedValidationError[];
  node_count: number;
  nodes: Array<{ type: string; name: string }>;
  /** Where the seed comes from on disk. Only "personal" seeds are
   *  deletable through the dashboard. */
  source: SeedSource;
  /** `brAIn-<area>` for store-shipped seeds, null for root/personal. */
  store: string | null;
  /** Unique node types this seed needs to spawn — derived from
   *  nodes[].type. The dashboard renders one chip per entry. */
  required_types: string[];
  /** Subset of required_types not currently in the type registry.
   *  Renders red in the UI and gates the Apply button. */
  missing_types: string[];
  /** For every entry in required_types: the store that ships it
   *  (e.g. brAIn-essentials) or null when unknown locally. Drives
   *  the "part of project X" tooltip. */
  type_sources: Record<string, string | null>;
}

export function getSeeds(): Promise<SeedInfo[]> {
  return request("/network/seeds");
}

export interface SeedApplyResult {
  seed: string;
  spawned: number;
  skipped: number;
  killed: number;
  installed: string[];
}

/**
 * Apply a seed. Default mode replaces the running network: every
 * current node is killed before the seed's nodes spawn (DB tables
 * survive — history, mcp tokens, etc. are kept). Pass `merge: true`
 * to leave the running network alone and only spawn missing names.
 */
export function applySeed(name: string, opts?: { merge?: boolean }): Promise<SeedApplyResult> {
  const qs = opts?.merge ? "?merge=true" : "";
  return request(`/network/seeds/${name}/apply${qs}`, { method: "POST" });
}

/**
 * Snapshot the running network as a new personal seed. Returns the
 * slug the file was saved under (display name → kebab-case). 409
 * collides on duplicate slug; pass `overwrite: true` to replace.
 */
export function savePersonalSeed(name: string, opts?: { description?: string; overwrite?: boolean }): Promise<{ slug: string; path: string }> {
  return request("/network/seeds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: opts?.description, overwrite: opts?.overwrite }),
  });
}

/** Delete a personal seed by slug. 403 on store/root seeds. */
export function deletePersonalSeed(slug: string): Promise<{ deleted: string }> {
  return request(`/network/seeds/${slug}`, { method: "DELETE" });
}

// === Agents (distributed runtime) ===

export interface AgentSnapshot {
  agent_id: string;
  host: string;
  pid: number;
  started_at: number;
  types: string[];
  ts: number;
}

export function getAgents(): Promise<AgentSnapshot[]> {
  return request("/agents");
}

// === History ===

export interface HistoryEntry {
  id: number;
  timestamp: number;
  action: string;
  node_id: string | null;
  node_name: string | null;
  node_type: string | null;
  details: string;
}

export function getNetworkHistory(opts?: {
  last?: number;
  action?: string;
  node_id?: string;
}): Promise<HistoryEntry[]> {
  const params = new URLSearchParams();
  if (opts?.last !== undefined) params.set("last", String(opts.last));
  if (opts?.action) params.set("action", opts.action);
  if (opts?.node_id) params.set("node_id", opts.node_id);
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";
  return request(`/network/history${suffix}`);
}

// === Network actions ===

export function resetNetwork(): Promise<{ killed: number }> {
  return request("/network/reset", { method: "POST" });
}

// === Node mailboxes ===

export interface MailboxInfo {
  pattern: string;
  total: number;
  unread: number;
  /** max_size — when total hits this, the next push evicts before adding. */
  capacity: number;
  /** Cumulative count of evictions since the node spawned. */
  dropped: number;
  messages: Array<{
    id: string;
    topic: string;
    criticality: number;
    from: string;
    timestamp: number;
    preview: string;
  }>;
}

export function getNodeMailboxes(id: string): Promise<MailboxInfo[]> {
  return request(`/nodes/${id}/mailboxes`);
}

export interface DeadLetterEntry {
  ts: number;
  error: string;
  message: Message;
}

export function getNodeDeadLetters(id: string): Promise<DeadLetterEntry[]> {
  return request(`/nodes/${id}/dead-letters`);
}

// === Node logs ===

export interface NodeLogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown>;
}

export function getNodeLogs(id: string, last = 50): Promise<NodeLogEntry[]> {
  return request(`/nodes/${id}/logs?last=${last}`);
}

// === Dev mode ===

export function getDevMode(): Promise<{ enabled: boolean }> {
  return request("/network/devmode");
}

export function setDevMode(enabled: boolean): Promise<{ enabled: boolean }> {
  return request("/network/devmode", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function tickNode(id: string): Promise<{ ticked: boolean }> {
  return request(`/nodes/${id}/tick`, { method: "POST" });
}

export function tickAll(): Promise<{ ticked: number }> {
  return request("/network/tick", { method: "POST" });
}

// === LLM config + CLI agents ===
// Re-exported from ./llm so existing callers (NodePanel, NodeLLMTab, …)
// keep working without changing their imports.
export {
  getLLMConfig, patchLLMConfig,
  getLLMModels, getLLMProviders, getLLMResolutionForNode,
  getCLIAgents, refreshCLIAgents,
} from "./llm";
export type {
  LLMModelChoice, LLMProviderStatus, LLMResolutionPreview,
  LLMGlobalConfig, CLIAgentStatus,
} from "./llm";
