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
import { CLIRegistry, type CLIRunResult, type CLIRunOptions } from "./cli-registry";
import { extractReasoningText } from "./reasoning";
import { wrapInputSchema, STOP_TOOL, warnIfUnionSchema } from "./llm-facade-helpers";

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
  /** Per-instance CLI agent (from config_overrides.cli). Routes
   *  `ctx.llm.agent()` to claude-code / codex / gemini for this node. */
  nodeCli?: string;
  /** This node's data directory — the default sandbox cwd for `agent()`. */
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
    // Discipline: warn when callers pass oneOf/anyOf — local LLMs handle
    // them unreliably. The right pattern is `ctx.llm.tools()` with one
    // flat tool per branch.
    warnIfUnionSchema(opts.tool.inputSchema, opts.tool.name);
    const top = candidates[0].spec;
    const failedProviders = new Set<string>();
    let lastError: Error | undefined;
    const messages = this.normaliseMessages(opts.prompt);
    const wrappedTool = aiTool({
      description: opts.tool.description,
      inputSchema: wrapInputSchema(opts.tool.inputSchema) as Parameters<typeof aiTool>[0]["inputSchema"],
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
            // Generous default — thinking-capable local models (gemma4,
            // qwen-thinking, …) burn tokens on internal reasoning before
            // the tool call. A tight budget cuts them off mid-thought and
            // ai-sdk reports "no tool call emitted". Callers may shrink
            // for known-cheap calls, but the default trades a few cents
            // of headroom for not silently failing on local models.
            maxOutputTokens: opts.maxTokens ?? 4096,
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

  /** Multi-tool dispatch. The model sees several tools each with their
   *  own flat inputSchema and picks one. ai-sdk handles the routing
   *  natively — no oneOf required. Same failover-chain semantics as
   *  text() / tool(). Returns `{toolName, args}` for the picked tool.
   *
   *  Use this instead of `tool()` + a `oneOf` discriminated schema:
   *  local LLMs handle the multi-tool path reliably, but botch oneOf.
   *
   *  **Framework-injected `stop` tool**: every multi-tool call also
   *  exposes a `stop` tool (zero args). This gives every LLM-powered
   *  handler a canonical "I'm done, nothing more to do" exit that
   *  works under `toolChoice: "required"` without forcing a noisy
   *  fake action. Callers should treat `{toolName: "stop"}` as the
   *  end of their step loop. Opt out with `allowStop: false` only if
   *  you have a genuine reason to forbid early termination. */
  async tools(opts: MultiToolOptions): Promise<MultiToolResult> {
    const userToolNames = Object.keys(opts.tools);
    if (userToolNames.length === 0) {
      throw new Error("ctx.llm.tools: pass at least one tool");
    }
    if (opts.allowStop !== false && "stop" in opts.tools) {
      throw new Error("ctx.llm.tools: `stop` is a framework-reserved tool name. Rename your tool or pass allowStop: false.");
    }
    const candidates = this.buildCandidates(opts.model, opts.fallback);
    if (candidates.length === 0) {
      throw new Error("ctx.llm.tools: no candidate models available");
    }
    // Warn per-tool on oneOf — same discipline as `tool()`. Multi-tool
    // is precisely the right replacement for oneOf at the dispatcher
    // level; warning here is a belt-and-suspenders catch when someone
    // nests a union INSIDE a per-tool schema by mistake.
    for (const [name, t] of Object.entries(opts.tools)) {
      warnIfUnionSchema(t.inputSchema, name);
    }
    // Merge the framework `stop` tool unless explicitly disabled.
    const effectiveTools = opts.allowStop === false
      ? opts.tools
      : { ...opts.tools, stop: STOP_TOOL };
    const toolNames = Object.keys(effectiveTools);
    const top = candidates[0].spec;
    const failedProviders = new Set<string>();
    let lastError: Error | undefined;
    const messages = this.normaliseMessages(opts.prompt);
    const wrapped = Object.fromEntries(
      Object.entries(effectiveTools).map(([name, t]) => [
        name,
        aiTool({
          description: t.description,
          inputSchema: wrapInputSchema(t.inputSchema) as Parameters<typeof aiTool>[0]["inputSchema"],
        }),
      ]),
    );
    const toolChoice = opts.toolChoice ?? "required";
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
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const start = Date.now();
        try {
          const model = this.deps.registry.getModel(candidate.spec);
          const stricterSuffix = attempt === 0
            ? ""
            : `\n\n>>> Previous attempt did not call a tool. You MUST call exactly one of: ${toolNames.join(", ")}. Do not reply in plain text.`;
          const result = await generateText({
            model,
            system: (opts.system ?? "") + stricterSuffix,
            messages,
            tools: wrapped,
            toolChoice,
            // Generous default — thinking-capable local models (gemma4,
            // qwen-thinking, …) burn tokens on internal reasoning before
            // the tool call. A tight budget cuts them off mid-thought and
            // ai-sdk reports "no tool call emitted". Callers may shrink
            // for known-cheap calls, but the default trades a few cents
            // of headroom for not silently failing on local models.
            maxOutputTokens: opts.maxTokens ?? 4096,
            abortSignal: opts.signal ?? this.deps.signal,
          });
          if (opts.onResult) try { opts.onResult(result); } catch { /* ignore */ }
          const picked = this.extractFirstToolCall(result, toolNames);
          const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
          if (picked) {
            this.emitUsage({
              call_kind: "tools", resolution, latency_ms: Date.now() - start,
              tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } : undefined,
            });
            return picked;
          }
          this.emitUsage({
            call_kind: "tools", resolution, latency_ms: Date.now() - start,
            tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } : undefined,
            error: "no tool call emitted",
          });
          lastError = new Error(`${candidate.spec}: no tool call emitted`);
          if (attempt === maxRetries) {
            failedProviders.add(provider);
            break;
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.emitUsage({
            call_kind: "tools", resolution, latency_ms: Date.now() - start,
            error: lastError.message,
          });
          if ((opts.signal ?? this.deps.signal).aborted) throw lastError;
          failedProviders.add(provider);
          break;
        }
      }
    }
    throw lastError ?? new Error("ctx.llm.tools: every candidate failed");
  }

  /** Delegate a task to an installed agentic CLI (claude-code, codex,
   *  gemini). Unlike text()/tool()/tools() — which drive a model through
   *  ai-sdk — this shells out to a CLI that runs its OWN tool loop. brAIn
   *  supplies the prompt, a sandboxed cwd (the node's dataDir by default)
   *  and a deadline, then returns the answer.
   *
   *  Routing: opts.cli → node's config_overrides.cli. There is no model
   *  fallback chain here — a CLI is an explicit, all-or-nothing choice.
   *  Emits a `cli` usage event for the same observability as model calls. */
  async agent(opts: AgentOptions): Promise<AgentResult> {
    const cli = opts.cli ?? this.deps.nodeCli;
    if (!cli) {
      throw new Error(
        "ctx.llm.agent: no CLI selected. Set this node's config_overrides.cli " +
        "(e.g. \"claude\") or pass opts.cli.",
      );
    }
    const registry = this.deps.cli ?? CLIRegistry.getInstance();
    const prompt = this.renderPrompt(opts.prompt, opts.system);
    const resolution: ResolutionTrace = {
      requested: `cli/${cli}`,
      resolved: `cli/${cli}`,
      layer: "explicit",
      fell_back: false,
    };
    const start = Date.now();
    try {
      const result = await registry.run(cli, prompt, {
        cwd: opts.cwd ?? this.deps.nodeDataDir,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal ?? this.deps.signal,
      });
      if (result.error) {
        this.emitUsage({ call_kind: "cli", resolution, latency_ms: Date.now() - start, error: result.error });
        throw new Error(`ctx.llm.agent(${cli}): ${result.error}`);
      }
      this.emitUsage({ call_kind: "cli", resolution, latency_ms: Date.now() - start });
      return { text: result.text, cli, raw: result.raw };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitUsage({ call_kind: "cli", resolution, latency_ms: Date.now() - start, error: message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /** Flatten the prompt (string or message array) + optional system into
   *  the single prompt string a CLI agent expects. */
  private renderPrompt(
    prompt: string | Array<{ role: "system" | "user" | "assistant"; content: string }>,
    system?: string,
  ): string {
    const body = typeof prompt === "string"
      ? prompt
      : prompt.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    return system ? `${system}\n\n${body}` : body;
  }

  /** Pull the first call to ANY of the supplied tool names out of a
   *  generateText result. Returns null if the model emitted nothing. */
  private extractFirstToolCall(result: unknown, toolNames: string[]): MultiToolResult | null {
    const names = new Set(toolNames);
    const r = result as {
      toolCalls?: Array<{ toolName?: string; input?: unknown }>;
      steps?: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }>;
    };
    const fromTop = r.toolCalls?.find((c) => c.toolName !== undefined && names.has(c.toolName));
    const call = fromTop ?? r.steps?.flatMap((s) => s.toolCalls ?? [])
      .find((c) => c.toolName !== undefined && names.has(c.toolName));
    if (!call?.toolName) return null;
    const args = typeof call.input === "object" && call.input !== null
      ? call.input as Record<string, unknown>
      : {};
    return { toolName: call.toolName, args };
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
