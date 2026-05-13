import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { logger } from "../logger";
import type { LLMConfigStore } from "./llm-config";
import { PROVIDER_DEFS } from "./provider-defs";

export interface ProviderStatus {
  name: string;
  available: boolean;
  models: string[];
  error?: string;
}

interface ProviderEntry {
  name: string;
  factory: (model: string) => LanguageModel;
  envKey: string;
  testModel: string;
  models: string[];
  // Optional override for the availability probe. Ollama uses this to
  // skip a `generateText` call (which would force a multi-GB model
  // load on cold boot and time out), hitting /api/tags instead.
  check?: () => Promise<{ models?: string[] }>;
}

let instance: LLMRegistry | null = null;

export class LLMRegistry {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly statuses = new Map<string, ProviderStatus>();
  private initialized = false;
  /** Optional config store: when set, credentials come from here
   *  (with env vars as a built-in fallback merged inside the store). */
  private configStore?: LLMConfigStore;
  private unsubscribeConfig?: () => void;
  /** When init / re-init is in flight, this resolves once it lands. UI
   *  endpoints can await it to ensure they read fresh statuses. */
  private pendingInit: Promise<void> | null = null;

  static getInstance(): LLMRegistry {
    if (!instance) {
      instance = new LLMRegistry();
    }
    return instance;
  }

  static resetInstance(): void {
    if (instance) instance.unsubscribeConfig?.();
    instance = null;
  }

  /** Wire a config store. The registry subscribes to changes and
   *  re-probes providers whenever credentials change. The returned
   *  promise stays settled — to know when the latest re-probe is done,
   *  call `awaitReady()`. */
  setConfigStore(store: LLMConfigStore): void {
    this.unsubscribeConfig?.();
    this.configStore = store;
    this.unsubscribeConfig = store.onChange(() => {
      this.pendingInit = this.reinit();
    });
  }

  private async reinit(): Promise<void> {
    this.initialized = false;
    this.providers.clear();
    this.statuses.clear();
    await this.initialize();
  }

  /** Wait for any in-flight init / re-init to settle. Cheap when idle. */
  async awaitReady(): Promise<void> {
    if (this.pendingInit) await this.pendingInit;
  }

  private credFor(provider: string, envKey: string): string | undefined {
    return this.configStore?.get().providers[provider]?.apiKey ?? process.env[envKey];
  }

  private baseURLFor(provider: string): string | undefined {
    // Custom base URLs are useful for: OpenAI-compatible servers (vLLM,
    // LM Studio, LocalAI, OpenRouter), Anthropic via a gateway, regional
    // Google endpoints, etc. Empty string is treated as "use the SDK
    // default" — same as undefined.
    const url = this.configStore?.get().providers[provider]?.baseURL;
    return url && url.length > 0 ? url : undefined;
  }

  private registerBuiltinProviders(): void {
    // Iterate over the curated provider catalog. Each entry is either
    // registered (key present OR no key required) or skipped silently.
    for (const def of PROVIDER_DEFS) {
      const apiKey = this.credFor(def.name, def.envKey);
      if (def.requireKey && !apiKey) continue;
      const baseURL = this.baseURLFor(def.name) ?? def.defaultBaseURL;
      const client = def.factory(apiKey ?? "none", baseURL);
      const key = apiKey ?? "none";
      const url = baseURL ?? def.defaultBaseURL ?? "";
      const listModels = def.listModels;
      this.providers.set(def.name, {
        name: def.name,
        factory: (m) => client(m),
        envKey: def.envKey,
        testModel: def.testModel,
        models: def.defaultModels,
        check: listModels ? () => listModels(url, key) : undefined,
      });
    }

    // Ollama is a special case: always registered (no key, just a
    // reachability probe via /api/tags) — that's the cheap path we use
    // instead of generateText since loading a multi-GB model on cold
    // boot would time out the SDK's internal probe budget.
    const ollamaUrl = this.configStore?.get().providers.ollama.baseURL
      ?? process.env.OLLAMA_BASE_URL
      ?? "http://localhost:11434";
    const ollamaClient = createOpenAI({ baseURL: `${ollamaUrl}/v1`, apiKey: "ollama" });
    this.providers.set("ollama", {
      name: "ollama",
      factory: (model) => ollamaClient(model),
      envKey: "OLLAMA_BASE_URL",
      testModel: process.env.OLLAMA_TEST_MODEL ?? "gemma4:e4b",
      models: [],
      check: async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(`${ollamaUrl}/api/tags`, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { models?: { name: string }[] };
          return { models: (body.models ?? []).map((m) => m.name) };
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Register providers now (env vars are available at this point)
    this.registerBuiltinProviders();

    logger.info("Checking LLM provider availability...");

    const checks = Array.from(this.providers.entries()).map(
      async ([key, provider]) => {
        try {
          let discoveredModels: string[] | undefined;
          if (provider.check) {
            const result = await provider.check();
            discoveredModels = result.models;
          } else {
            // OpenAI now rejects maxOutputTokens < 16 (response is invalid
            // with "Expected a value >= 16, but got 5"). Bumping to 16 keeps
            // the probe cheap while staying within every provider's bounds.
            await generateText({
              model: provider.factory(provider.testModel),
              prompt: "Say OK",
              maxOutputTokens: 16,
            });
          }

          const models = discoveredModels ?? provider.models;
          const status: ProviderStatus = {
            name: provider.name,
            available: true,
            models,
          };
          this.statuses.set(key, status);
          logger.info({ provider: key, models: models.length }, "Provider available");
        } catch (err) {
          const status: ProviderStatus = {
            name: provider.name,
            available: false,
            models: provider.models,
            error: err instanceof Error ? err.message : String(err),
          };
          this.statuses.set(key, status);
          logger.warn({ provider: key, error: status.error }, "Provider unavailable");
        }
      },
    );

    await Promise.allSettled(checks);
    this.initialized = true;

    const available = Array.from(this.statuses.values()).filter((s) => s.available);
    logger.info(
      { available: available.map((s) => s.name), total: this.providers.size },
      "LLM registry initialized",
    );
  }

  getModel(spec: string): LanguageModel {
    // spec format: "provider/model" e.g. "anthropic/claude-sonnet-4-6"
    const [providerName, ...modelParts] = spec.split("/");
    const modelName = modelParts.join("/");

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerName}. Available: ${Array.from(this.providers.keys()).join(", ")}`);
    }

    const status = this.statuses.get(providerName);
    if (status && !status.available) {
      throw new Error(`Provider ${providerName} is not available: ${status.error}`);
    }

    return provider.factory(modelName);
  }

  getStatuses(): ProviderStatus[] {
    return Array.from(this.statuses.values());
  }

  getAvailableProviders(): string[] {
    return Array.from(this.statuses.entries())
      .filter(([, s]) => s.available)
      .map(([key]) => key);
  }

  isAvailable(provider: string): boolean {
    return this.statuses.get(provider)?.available ?? false;
  }

  /** True iff the given "provider/model" spec is reachable in the
   *  registry (provider was probed successfully). Doesn't verify the
   *  specific model exists — that surfaces when we call generateText. */
  isSpecAvailable(spec: string): boolean {
    const provider = spec.split("/")[0];
    return this.isAvailable(provider);
  }

  /** Walk a list of candidate specs and return the first one whose
   *  provider is reachable. Returns null if nothing fits. The caller
   *  can then use `getModel(resolved)` to actually run with it. */
  resolveSpec(candidates: string[]): string | null {
    for (const spec of candidates) {
      if (this.isSpecAvailable(spec)) return spec;
    }
    return null;
  }
}

