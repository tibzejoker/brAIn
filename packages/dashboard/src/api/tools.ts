/**
 * Dashboard API client for the network-wide tool catalog.
 * Mirrors the REST endpoints in packages/api/src/rest/tools.controller.ts.
 */
import { request } from "./request";

export interface ToolDescriptor {
  node_id: string;
  node_type: string;
  node_name: string;
  topic: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function getTools(): Promise<ToolDescriptor[]> {
  return request("/tools");
}

export function getToolsForNode(node_id: string): Promise<ToolDescriptor[]> {
  return request(`/tools/${encodeURIComponent(node_id)}`);
}
