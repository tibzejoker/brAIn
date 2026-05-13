import {
  Controller, Get, Patch, Post, Param, Body, HttpException, HttpStatus,
} from "@nestjs/common";
import { BrainService, type LLMConfig, type CLIStatus } from "@brain/core";

/**
 * REST surface for the project-wide LLM configuration + per-node
 * resolution previews. Powers the dashboard's LLM settings page and
 * the "LLM" tab inside the node panel.
 *
 * GET  /llm/config             — redacted global config (default model,
 *                                 fallback chain, providers with masked
 *                                 API keys)
 * PATCH /llm/config            — update the global config (any subset)
 * GET  /llm/models             — currently-reachable provider/model
 *                                 list — for UI dropdowns
 * GET  /llm/providers          — provider availability status + (for
 *                                 each provider) the redacted creds
 * GET  /llm/nodes/:id/preview  — what this node would resolve to right
 *                                 now (preview without making a call)
 */
@Controller("llm")
export class LLMController {
  constructor(private readonly brain: BrainService) {}

  @Get("config")
  getConfig(): LLMConfig {
    return this.brain.llmConfig.getRedacted();
  }

  @Patch("config")
  async patchConfig(@Body() body: Partial<LLMConfig>): Promise<LLMConfig> {
    this.brain.llmConfig.update(body);
    // Wait for the registry to finish re-probing providers — otherwise
    // the dashboard's immediate refresh would race the in-flight probe
    // and show stale "unavailable" badges until the user manually
    // refreshes. awaitReady() resolves immediately when nothing is in
    // flight, so the unchanged-config case stays fast.
    await this.brain.llm.awaitReady();
    return this.brain.llmConfig.getRedacted();
  }

  @Get("models")
  listModels(): Array<{ spec: string; provider: string; model: string }> {
    const out: Array<{ spec: string; provider: string; model: string }> = [];
    for (const s of this.brain.llm.getStatuses()) {
      if (!s.available) continue;
      for (const m of s.models) out.push({ spec: `${s.name}/${m}`, provider: s.name, model: m });
    }
    return out;
  }

  @Get("providers")
  listProviders(): Array<{
    name: string;
    available: boolean;
    models: string[];
    error?: string;
    apiKey?: string;       // redacted form, never the real key
    baseURL?: string;
  }> {
    // Return EVERY known provider — even those with no key yet, so the
    // dashboard has a row to enter the key into. Statuses cover only
    // registered providers; we merge in the rest as "unavailable" with
    // empty models.
    const cfg = this.brain.llmConfig.getRedacted();
    const providers: Partial<Record<string, { apiKey?: string; baseURL?: string }>> = cfg.providers;
    const statuses = new Map(this.brain.llm.getStatuses().map((s) => [s.name, s]));
    // Curated catalog of every provider the framework knows how to wire
    // up. Some need API keys (anthropic, openai, …), some are
    // self-hosted / OpenAI-compat (ollama, lm-studio, vllm, localai),
    // OpenRouter sits in between (cloud + key + OpenAI-compat). The
    // dashboard renders one card per entry regardless of whether the
    // registry has actually registered it yet.
    const known = [
      "anthropic", "openai", "google", "ollama",
      "mistral", "xai", "groq", "cerebras", "deepseek",
      "togetherai", "fireworks", "perplexity", "cohere",
      "openrouter", "lm-studio", "vllm", "localai",
    ];
    return known.map((name) => {
      const s = statuses.get(name);
      return {
        name,
        available: s?.available ?? false,
        models: s?.models ?? [],
        error: s?.error ?? (s ? undefined : "not configured yet"),
        apiKey: providers[name]?.apiKey,
        baseURL: providers[name]?.baseURL,
      };
    });
  }

  @Get("clis")
  async listCLIs(): Promise<CLIStatus[]> {
    // The CLI registry initialises lazily; if a `which claude` check is
    // still in flight, kick it.
    await this.brain.cli.initialize();
    return this.brain.cli.getStatuses();
  }

  @Post("clis/refresh")
  async refreshCLIs(): Promise<CLIStatus[]> {
    await this.brain.cli.refresh();
    return this.brain.cli.getStatuses();
  }

  @Get("nodes/:id/preview")
  previewForNode(@Param("id") id: string): {
    requested: string; resolved: string; layer: string; fell_back: boolean; fallback_reason?: string;
  } {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    const cfg = this.brain.llmConfig.get();
    const candidates: string[] = [];
    const nodeModel = node.config_overrides?.model as string | undefined;
    if (nodeModel) candidates.push(nodeModel);
    if (cfg.defaultModel) candidates.push(cfg.defaultModel);
    candidates.push(...cfg.fallbackChain);
    // Walk in order, return first reachable.
    const layers: ("node-override" | "global-default" | "fallback")[] = [];
    if (nodeModel) layers.push("node-override");
    if (cfg.defaultModel) layers.push("global-default");
    for (let i = 0; i < cfg.fallbackChain.length; i++) layers.push("fallback");
    const top = candidates[0] ?? "ollama/gemma4:e4b";
    for (let i = 0; i < candidates.length; i++) {
      const spec = candidates[i];
      if (this.brain.llm.isSpecAvailable(spec)) {
        return {
          requested: top,
          resolved: spec,
          layer: layers[i] ?? "fallback",
          fell_back: spec !== top,
          fallback_reason: spec !== top ? `${top} unavailable` : undefined,
        };
      }
    }
    return { requested: top, resolved: top, layer: layers[0] ?? "fallback", fell_back: false };
  }
}
