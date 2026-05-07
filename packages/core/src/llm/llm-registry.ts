import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { logger } from "../logger";

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

  static getInstance(): LLMRegistry {
    if (!instance) {
      instance = new LLMRegistry();
    }
    return instance;
  }

  static resetInstance(): void {
    instance = null;
  }


  private registerBuiltinProviders(): void {
    // Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      this.providers.set("anthropic", {
        name: "anthropic",
        factory: (model) => anthropic(model),
        envKey: "ANTHROPIC_API_KEY",
        testModel: "claude-haiku-4-5-20251001",
        models: [
          "claude-opus-4-6",
          "claude-sonnet-4-6",
          "claude-haiku-4-5-20251001",
        ],
      });
    }

    // OpenAI
    if (process.env.OPENAI_API_KEY) {
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.providers.set("openai", {
        name: "openai",
        factory: (model) => openai(model),
        envKey: "OPENAI_API_KEY",
        testModel: "gpt-4o-mini",
        models: [
          "gpt-4o",
          "gpt-4o-mini",
          "o3-mini",
        ],
      });
    }

    // Google
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
      this.providers.set("google", {
        name: "google",
        factory: (model) => google(model),
        envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
        testModel: "gemini-2.0-flash",
        models: [
          "gemini-2.5-pro",
          "gemini-2.5-flash",
          "gemini-2.0-flash",
        ],
      });
    }

    // Ollama (via OpenAI-compatible API, no key needed)
    const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const ollama = createOpenAI({
      baseURL: `${ollamaUrl}/v1`,
      apiKey: "ollama",
    });
    this.providers.set("ollama", {
      name: "ollama",
      factory: (model) => ollama(model),
      envKey: "OLLAMA_BASE_URL",
      testModel: process.env.OLLAMA_TEST_MODEL ?? "gemma4:e4b",
      models: [],
      check: async () => {
        // /api/tags is the cheap probe: confirms the daemon is up and
        // returns the list of pulled models without loading any of them.
        // Doing a `generateText` instead would force Ollama to load the
        // test model into RAM/VRAM (multi-GB, can take >30s on cold
        // boot), which the AI SDK's internal timeout misreports as
        // "Cannot connect to API".
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
            await generateText({
              model: provider.factory(provider.testModel),
              prompt: "Say OK",
              maxOutputTokens: 5,
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
}
