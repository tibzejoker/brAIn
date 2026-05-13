/**
 * `ctx.llm.*` — the per-node LLM facade.
 *
 * Each ctx that the runner builds gets its own LLMFacade instance with
 * the node id baked in, so every LLM call automatically:
 *
 *  - resolves the model from override → global default → fallback chain
 *  - extracts reasoning-style text into a flat string
 *  - emits an `llm.usage` bus event with attribution
 *
 * Handlers should NEVER import LLMRegistry / generateText / ai directly
 * anymore — go through ctx.llm. That keeps the boilerplate centralised
 * and means provider swaps don't ripple into nodes.
 */
import { generateText, tool as aiTool } from "ai";
import type { IBusService } from "../bus/bus.interface";
import type { LLMRegistry } from "./llm-registry";
import type { LLMConfigStore } from "./llm-config";
import { extractReasoningText } from "./reasoning";

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
  call_kind: "text" | "tool" | "agent" | "cli";
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

export class LLMFacade {
  constructor(private readonly deps: LLMFacadeDeps) {}

  /** Plain text generation. Walks the candidate chain end-to-end:
   *
   *   1. Pick the first model whose provider is currently reachable.
   *   2. Call it. If it returns, we're done.
   *   3. If it throws AND the user hasn't cancelled the iteration AND
   *      the error isn't "you screwed up the call", skip every other
   *      candidate on the same provider (they'll fail the same way)
   *      and try the next available provider.
   *   4. If everything fails, throw the last real error.
   *
   *  Each attempt emits its own `llm.usage` event so the dashboard sees
   *  the failover trail, not just the final result. */
  async text(opts: TextOptions): Promise<string> {
    const candidates = this.buildCandidates(opts.model, opts.fallback);
    if (candidates.length === 0) {
      throw new Error("ctx.llm.text: no candidate models available");
    }
    const top = candidates[0].spec;
    const failedProviders = new Set<string>();
    let lastError: Error | undefined;
    const messages = this.normaliseMessages(opts.prompt);

    for (const candidate of candidates) {
      const provider = candidate.spec.split("/")[0];
      // Provider previously errored on this same call — skip its other models.
      if (failedProviders.has(provider)) continue;
      // Provider isn't reachable at all (no key, last probe failed). Skip
      // without making a network call; emit a usage event so the dashboard
      // still sees "we tried this one and it was unavailable".
      if (!this.deps.registry.isSpecAvailable(candidate.spec)) {
        failedProviders.add(provider);
        continue;
      }

      const resolution: ResolutionTrace = {
        requested: top,
        resolved: candidate.spec,
        layer: candidate.layer,
        fell_back: candidate.spec !== top,
        fallback_reason: candidate.spec !== top
          ? (lastError?.message ?? `${top} unavailable`)
          : undefined,
      };
      const start = Date.now();
      try {
        const model = this.deps.registry.getModel(candidate.spec);
        const callSignal = opts.signal ?? this.deps.signal;
        const result = await generateText({
          model,
          system: opts.system,
          messages,
          maxOutputTokens: opts.maxTokens ?? 1024,
          abortSignal: callSignal,
        });
        const text = extractReasoningText(result, { stripReasoning: opts.stripReasoning ?? true }) ?? "";
        const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
        this.emitUsage({
          call_kind: "text", resolution, latency_ms: Date.now() - start,
          tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } : undefined,
        });
        return text;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.emitUsage({
          call_kind: "text", resolution, latency_ms: Date.now() - start,
          error: lastError.message,
        });
        // User cancelled — propagate immediately, don't keep retrying.
        if ((opts.signal ?? this.deps.signal).aborted) throw lastError;
        // Provider-level error (auth, billing, network, server crash, rate
        // limit, …) — other models on the same provider will fail with
        // the same error, so blacklist it and walk to the next provider.
        // This is the heart of the failover behaviour.
        failedProviders.add(provider);
      }
    }

    throw lastError ?? new Error("ctx.llm.text: every candidate failed");
  }

  /** Forced tool call — the model MUST emit a structured args object
   *  matching the supplied zod schema. Same chain + failover semantics
   *  as text(). If the first attempt at a candidate doesn't return a
   *  tool call, we retry up to `retries` times with a stricter system
   *  prompt before moving to the next provider. The ai-sdk validates
   *  the args against the schema; callers get them typed.
   */
  async tool<Args = Record<string, unknown>>(opts: ToolOptions): Promise<Args> {
    const candidates = this.buildCandidates(opts.model, opts.fallback);
    if (candidates.length === 0) {
      throw new Error("ctx.llm.tool: no candidate models available");
    }
    const top = candidates[0].spec;
    const failedProviders = new Set<string>();
    let lastError: Error | undefined;
    const messages = this.normaliseMessages(opts.prompt);
    // `inputSchema` comes in as `unknown` because the public types in
    // @brain/sdk can't pull in a `z.ZodTypeAny` dependency. ai-sdk's
    // `tool()` accepts either a zod schema or a JSON-schema object; we
    // hand whatever the caller gave us through as a typed parameter.
    const wrappedTool = aiTool({
      description: opts.tool.description,
      inputSchema: opts.tool.inputSchema as Parameters<typeof aiTool>[0]["inputSchema"],
    });
    const maxRetries = Math.max(0, opts.retries ?? 1);

    for (const candidate of candidates) {
      const provider = candidate.spec.split("/")[0];
      if (failedProviders.has(provider)) continue;
      if (!this.deps.registry.isSpecAvailable(candidate.spec)) {
        failedProviders.add(provider);
        continue;
      }

      const resolution: ResolutionTrace = {
        requested: top,
        resolved: candidate.spec,
        layer: candidate.layer,
        fell_back: candidate.spec !== top,
        fallback_reason: candidate.spec !== top ? (lastError?.message ?? `${top} unavailable`) : undefined,
      };

      // Within a single candidate, we retry on "model emitted text but
      // no tool call". A different error (network, auth, etc.) escapes
      // this loop and the outer one moves to the next provider.
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const start = Date.now();
        try {
          const model = this.deps.registry.getModel(candidate.spec);
          const system = attempt === 0
            ? opts.system
            : `${opts.system ?? ""}\n\n>>> Previous attempt did not call the tool. You MUST call \`${opts.tool.name}\` exactly once. Do not reply in plain text.`;
          const result = await generateText({
            model,
            system,
            messages,
            tools: { [opts.tool.name]: wrappedTool },
            toolChoice: "required",
            maxOutputTokens: opts.maxTokens ?? 2048,
            abortSignal: opts.signal ?? this.deps.signal,
          });
          if (opts.onResult) {
            try { opts.onResult(result); } catch { /* ignore observer bugs */ }
          }
          const input = this.extractToolInput(result, opts.tool.name);
          const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
          if (input) {
            this.emitUsage({
              call_kind: "tool", resolution, latency_ms: Date.now() - start,
              tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } : undefined,
            });
            return input as Args;
          }
          // Tool wasn't called: count this attempt as "wasted" and either
          // retry-with-stricter-prompt or give up on this provider.
          this.emitUsage({
            call_kind: "tool", resolution, latency_ms: Date.now() - start,
            tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } : undefined,
            error: "no tool call emitted",
          });
          lastError = new Error(`${candidate.spec}: no tool call emitted`);
          if (attempt === maxRetries) {
            failedProviders.add(provider);
            break; // out of attempts on this candidate — try the next provider
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.emitUsage({
            call_kind: "tool", resolution, latency_ms: Date.now() - start,
            error: lastError.message,
          });
          if ((opts.signal ?? this.deps.signal).aborted) throw lastError;
          // Real provider error: skip to the next provider (no retries on this one).
          failedProviders.add(provider);
          break;
        }
      }
    }

    throw lastError ?? new Error("ctx.llm.tool: every candidate failed");
  }

  /** Pull the first matching tool call out of a generateText result.
   *  ai-sdk surfaces tool calls in two places depending on whether the
   *  model went through internal steps — we check both. */
  private extractToolInput(result: unknown, toolName: string): Record<string, unknown> | null {
    const r = result as {
      toolCalls?: Array<{ toolName?: string; input?: unknown }>;
      steps?: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }>;
    };
    const fromTop = r.toolCalls?.find((c) => c.toolName === toolName);
    const call = fromTop ?? r.steps?.flatMap((s) => s.toolCalls ?? []).find((c) => c.toolName === toolName);
    if (!call || typeof call.input !== "object" || call.input === null) return null;
    return call.input as Record<string, unknown>;
  }

  /** Build the ordered candidate list, deduped across layers. Public for
   *  reuse by tool() / agent() once we add them. */
  private buildCandidates(
    explicit: string | undefined,
    fallbackOverride: string[] | undefined,
  ): Array<{ spec: string; layer: ResolutionTrace["layer"] }> {
    if (explicit) {
      return [{ spec: explicit, layer: "explicit" }];
    }
    const cfg = this.deps.config.get();
    const seen = new Set<string>();
    const out: Array<{ spec: string; layer: ResolutionTrace["layer"] }> = [];
    const push = (spec: string | undefined, layer: ResolutionTrace["layer"]): void => {
      if (!spec || seen.has(spec)) return;
      seen.add(spec);
      out.push({ spec, layer });
    };
    push(this.deps.nodeModel, "node-override");
    push(cfg.defaultModel, "global-default");
    for (const spec of fallbackOverride ?? cfg.fallbackChain) push(spec, "fallback");
    return out;
  }

  /** Get the resolution trace without making a call — useful for the
   *  dashboard to preview "what would this node use right now". */
  resolveModel(explicit?: string, fallbackOverride?: string[]): ResolutionTrace {
    const candidates = this.buildCandidates(explicit, fallbackOverride);
    const top = candidates[0]?.spec ?? "ollama/gemma4:e4b";
    for (const c of candidates) {
      if (this.deps.registry.isSpecAvailable(c.spec)) {
        return {
          requested: top,
          resolved: c.spec,
          layer: c.layer,
          fell_back: c.spec !== top,
          fallback_reason: c.spec !== top ? `${top} unavailable` : undefined,
        };
      }
    }
    // Nothing reachable — surface the top candidate so the dashboard at
    // least shows what the user asked for. A real call would emit a
    // usage event with the failure.
    return { requested: top, resolved: top, layer: candidates[0]?.layer ?? "fallback", fell_back: false };
  }

  /** Returns the currently-reachable provider/model list for UI
   *  dropdowns. Provider entries with `available: false` are filtered. */
  listModels(): Array<{ spec: string; provider: string; model: string }> {
    const out: Array<{ spec: string; provider: string; model: string }> = [];
    for (const status of this.deps.registry.getStatuses()) {
      if (!status.available) continue;
      for (const m of status.models) {
        out.push({ spec: `${status.name}/${m}`, provider: status.name, model: m });
      }
    }
    return out;
  }

  private normaliseMessages(
    p: string | Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return typeof p === "string" ? [{ role: "user", content: p }] : p;
  }

  private emitUsage(input: {
    call_kind: UsageEvent["call_kind"];
    resolution: ResolutionTrace;
    latency_ms: number;
    tokens?: UsageEvent["tokens"];
    error?: string;
  }): void {
    const event: UsageEvent = {
      node_id: this.deps.nodeId,
      node_name: this.deps.nodeName,
      node_type: this.deps.nodeType,
      call_kind: input.call_kind,
      requested_model: input.resolution.requested,
      resolution_layer: input.resolution.layer,
      resolved_model: input.resolution.resolved,
      provider: input.resolution.resolved.split("/")[0],
      fell_back: input.resolution.fell_back,
      fallback_reason: input.resolution.fallback_reason,
      latency_ms: input.latency_ms,
      tokens: input.tokens,
      error: input.error,
    };
    try {
      this.deps.bus.publish({
        from: this.deps.nodeId,
        topic: "llm.usage",
        type: "text",
        criticality: 0,
        payload: { content: JSON.stringify(event) },
        metadata: event as unknown as Record<string, unknown>,
      });
    } catch {
      // Telemetry must never break a call.
    }
  }
}
