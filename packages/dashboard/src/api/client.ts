import type {
  NetworkSnapshot,
  NodeSnapshot,
  NodeTypeConfig,
  NodeInstanceConfig,
  Message,
} from "./types";

const BASE = "";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

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

export function applySeed(name: string): Promise<{ seeded: number; seed: string }> {
  return request(`/network/seeds/${name}/apply`, { method: "POST" });
}

// === Store ===

export interface StoreNodeStatus {
  name: string;
  package_name: string;
  repo: string;
  subpath: string;
  version: string;
  description: string;
  tags?: string[];
  has_ui?: boolean;
  needs_python?: boolean;
  needs_ollama?: boolean;
  installed: boolean;
  install_path: string | null;
}

export interface StoreInstallResult {
  status: "installed" | "already_present" | "failed";
  message: string;
  cloned_to: string | null;
  re_scanned_types: number;
}

export function getStoreNodes(): Promise<StoreNodeStatus[]> {
  return request("/store/nodes");
}

export function installFromStore(packageName: string): Promise<StoreInstallResult> {
  return request("/store/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package_name: packageName }),
  });
}

export interface StoreCandidate {
  type_name: string;
  package_name: string;
  workspace: string;
  description: string;
  tags: string[];
  has_ui: boolean;
  created_by?: string;
  created_at?: string;
  registry_entry: {
    name: string;
    package_name: string;
    version: string;
    tags?: string[];
    description: string;
    has_ui?: boolean;
  };
}

export function getStoreCandidates(): Promise<StoreCandidate[]> {
  return request("/store/candidates");
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
