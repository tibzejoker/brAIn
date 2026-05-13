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

export function getLLMModels(): Promise<LLMModelChoice[]> {
  return request("/llm/models");
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

export function getCLIAgents(): Promise<CLIAgentStatus[]> {
  return request("/llm/clis");
}

export function refreshCLIAgents(): Promise<CLIAgentStatus[]> {
  return request("/llm/clis/refresh", { method: "POST" });
}
