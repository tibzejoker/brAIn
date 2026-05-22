/**
 * Option / result / deps types for the LLM facade. Split out of
 * `llm-facade.ts` to keep that file under the max-lines budget.
 */
import type { IBusService } from "../bus/bus.interface";
import type { LLMRegistry } from "./llm-registry";
import type { LLMConfigStore } from "./llm-config";
import type { CLIRunOptions, CLIRunResult } from "./cli-registry";

export interface LLMFacadeDeps {
  registry: LLMRegistry;
  config: LLMConfigStore;
  bus: IBusService;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** Per-instance preferred model (from config_overrides). Wins over
   *  global default but falls back to it when unavailable. */
  nodeModel?: string;
  /** Per-instance CLI agent (from config_overrides.cli). When set, the
   *  framework routes text()/tools()/agent() through the CLI — the node
   *  doesn't branch on model-vs-CLI, it just asks and gets an answer. */
  nodeCli?: string;
  /** This node's data directory — the default sandbox cwd for CLI runs. */
  nodeDataDir?: string;
  /** CLI agent runner. Defaults to the process-wide `CLIRegistry`
   *  singleton; injectable so tests can supply a fake without a real
   *  claude/codex/gemini binary on PATH. */
  cli?: { run(name: string, prompt: string, opts?: CLIRunOptions): Promise<CLIRunResult> };
  signal: AbortSignal;
}

export interface TextOptions {
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  /** Override the resolved model just for this call (rare — usually
   *  prefer the node config or the global default). */
  model?: string;
  /** Override the fallback chain just for this call. */
  fallback?: string[];
  maxTokens?: number;
  stripReasoning?: boolean;
  /** Override the abort signal for this call. Defaults to `ctx.signal`
   *  which lives for one handler iteration — pass a fresh signal here
   *  if you fire LLM calls from a background task that outlives the
   *  current iteration (e.g. a cache refill loop). */
  signal?: AbortSignal;
}

export interface ToolOptions<Schema = unknown> {
  tool: {
    name: string;
    description: string;
    inputSchema: Schema;
  };
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  model?: string;
  fallback?: string[];
  maxTokens?: number;
  /** Retries with a stricter "you MUST call the tool" prompt if the
   *  model emits text without a tool call. Default 1. */
  retries?: number;
  /** Optional observer of the raw ai-sdk result — handy for telemetry
   *  / debugging without monkey-patching the facade. */
  onResult?: (result: unknown) => void;
  /** Override the abort signal — see TextOptions.signal. */
  signal?: AbortSignal;
}

export interface MultiToolOptions {
  tools: Record<string, { description: string; inputSchema: unknown }>;
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  model?: string;
  fallback?: string[];
  maxTokens?: number;
  toolChoice?: "required" | "auto";
  retries?: number;
  signal?: AbortSignal;
  onResult?: (result: unknown) => void;
  /** Default true — see SDK LLMMultiToolOptions for semantics. */
  allowStop?: boolean;
}

export interface MultiToolResult {
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgentOptions {
  prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  /** Which CLI agent to run. Defaults to the node's config_overrides.cli. */
  cli?: string;
  /** Sandbox cwd — defaults to the node's dataDir. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  text: string;
  cli: string;
  raw: string;
}

export interface ResolutionTrace {
  requested: string;
  resolved: string;
  layer: "node-override" | "global-default" | "fallback" | "explicit";
  fell_back: boolean;
  fallback_reason?: string;
}

export interface UsageEvent {
  node_id: string;
  node_name: string;
  node_type: string;
  call_kind: "text" | "tool" | "tools" | "agent" | "cli";
  requested_model: string;
  resolution_layer: ResolutionTrace["layer"];
  resolved_model: string;
  provider: string;
  fell_back: boolean;
  fallback_reason?: string;
  latency_ms: number;
  tokens?: { input?: number; output?: number; total?: number };
  error?: string;
}
