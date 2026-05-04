import type {
  NetworkSnapshot,
  NodeSnapshot,
  NodeTypeConfig,
  NodeInstanceConfig,
  Message,
} from "./types";
import { request } from "./request";

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
}): Promise<Message[]> {
  const params = new URLSearchParams();
  if (opts?.last !== undefined) params.set("last", String(opts.last));
  if (opts?.topic) params.set("topic", opts.topic);
  if (opts?.min_criticality !== undefined)
    params.set("min_criticality", String(opts.min_criticality));
  const qs = params.toString();
  return request(`/network/messages${qs ? `?${qs}` : ""}`);
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

export function wakeNode(
  id: string,
  message?: string,
): Promise<{ woken: boolean; node_id: string }> {
  return request(`/nodes/${id}/wake`, {
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
 * Publish a message into a node from the dashboard. Wraps the
 * existing `/nodes/:id/ui/send` endpoint that turns the dashboard
 * into a bus publisher addressed at one node.
 */
export function sendToNode(
  id: string,
  topic: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<{ published: boolean }> {
  return request(`/nodes/${id}/ui/send`, {
    method: "POST",
    body: JSON.stringify({ topic, content, metadata }),
  });
}

// === Seeds ===

export interface SeedValidationError {
  line?: number;
  message: string;
}

export interface SeedInfo {
  name: string;
  filename: string;
  valid: boolean;
  errors: SeedValidationError[];
  node_count: number;
  nodes: Array<{ type: string; name: string }>;
}

export function getSeeds(): Promise<SeedInfo[]> {
  return request("/network/seeds");
}

export interface SeedApplyResult {
  seed: string;
  spawned: number;
  skipped: number;
  installed: string[];
}

export function applySeed(name: string): Promise<SeedApplyResult> {
  return request(`/network/seeds/${name}/apply`, { method: "POST" });
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
  return request(`/network/history${qs ? `?${qs}` : ""}`);
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
