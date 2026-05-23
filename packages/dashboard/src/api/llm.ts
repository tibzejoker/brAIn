/**
 * Dashboard API client for the LLM settings surface.
 * Mirrors the REST endpoints in packages/api/src/rest/llm.controller.ts.
 */
import { request } from "./request";

export interface LLMModelChoice {
  spec: string;
  provider: string;
  model: string;
}

export interface LLMProviderStatus {
  name: string;
  available: boolean;
  models: string[];
  error?: string;
  apiKey?: string;       // redacted form
  baseURL?: string;
}

export interface LLMResolutionPreview {
  requested: string;
  resolved: string;
  layer: "node-override" | "global-default" | "fallback" | "explicit";
  fell_back: boolean;
  fallback_reason?: string;
}

export interface LLMGlobalConfig {
  defaultModel?: string;
  fallbackChain: string[];
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
}

export function getLLMConfig(): Promise<LLMGlobalConfig> {
  return request("/llm/config");
}

export function patchLLMConfig(patch: Partial<LLMGlobalConfig>): Promise<LLMGlobalConfig> {
  return request("/llm/config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Optional `hub` query — when editing a peer-owned node, the panel passes
 *  the owner's hub_id so the dropdown reflects what THAT hub can actually
 *  reach (we'd silently configure a Mac-only Ollama model on a PC node
 *  otherwise). */
export function getLLMModels(hub?: string): Promise<LLMModelChoice[]> {
  return request(hub ? `/llm/models?hub=${encodeURIComponent(hub)}` : "/llm/models");
}

export function getLLMProviders(): Promise<LLMProviderStatus[]> {
  return request("/llm/providers");
}

export function getLLMResolutionForNode(id: string): Promise<LLMResolutionPreview> {
  return request(`/llm/nodes/${id}/preview`);
}

export interface CLIAgentStatus {
  name: string;
  command: string;
  available: boolean;
  version?: string;
  error?: string;
  installCommand: string;
  loginCommand: string;
  homepage: string;
}

export function getCLIAgents(hub?: string): Promise<CLIAgentStatus[]> {
  return request(hub ? `/llm/clis?hub=${encodeURIComponent(hub)}` : "/llm/clis");
}

export function refreshCLIAgents(): Promise<CLIAgentStatus[]> {
  return request("/llm/clis/refresh", { method: "POST" });
}
