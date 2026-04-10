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
