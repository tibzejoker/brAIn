/**
 * Catalog of every LLM provider the framework knows how to wire.
 *
 * The registry iterates this table at init time, asking each entry for
 * its current credentials (key + optional base URL) and either:
 *
 *   - registering a provider that uses the provided `factory` to mint
 *     LanguageModel handles, or
 *   - skipping it when no credential is configured (paid providers
 *     `requireKey: true`).
 *
 * Adding a new provider = adding one entry below. No registry changes.
 */
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createXai } from "@ai-sdk/xai";
import { createGroq } from "@ai-sdk/groq";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createFireworks } from "@ai-sdk/fireworks";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createCohere } from "@ai-sdk/cohere";
import {
  listModelsAnthropic, listModelsCohere, listModelsGoogle,
  listModelsOpenAI, listModelsOpenAIStyle,
} from "./model-listers";

export interface ProviderDef {
  name: string;
  envKey: string;
  /** Mints LanguageModel handles. Receives the API key + optional baseURL. */
  factory: (apiKey: string, baseURL?: string) => (model: string) => LanguageModel;
  testModel: string;
  /** Hardcoded fallback when no live listing helper exists. */
  defaultModels: string[];
  /** Default base URL. The dashboard / config override always wins. */
  defaultBaseURL?: string;
  /** Live listing — return real model catalog + serves as the probe. */
  listModels?: (baseURL: string, apiKey: string) => Promise<{ models: string[] }>;
  /** True for paid services. The registry skips them when no key is set. */
  requireKey: boolean;
}

export const PROVIDER_DEFS: ProviderDef[] = [
  // === Hosted, key required ===
  {
    name: "anthropic", envKey: "ANTHROPIC_API_KEY",
    factory: (apiKey, baseURL) => createAnthropic({ apiKey, baseURL }),
    testModel: "claude-haiku-4-5-20251001",
    defaultModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    defaultBaseURL: "https://api.anthropic.com",
    listModels: listModelsAnthropic,
    requireKey: true,
  },
  {
    name: "openai", envKey: "OPENAI_API_KEY",
    factory: (apiKey, baseURL) => createOpenAI({ apiKey, baseURL }),
    testModel: "gpt-4o-mini",
    defaultModels: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
    defaultBaseURL: "https://api.openai.com/v1",
    listModels: listModelsOpenAI,
    requireKey: true,
  },
  {
    name: "google", envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    factory: (apiKey, baseURL) => createGoogleGenerativeAI({ apiKey, baseURL }),
    testModel: "gemini-2.0-flash",
    defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    defaultBaseURL: "https://generativelanguage.googleapis.com",
    listModels: listModelsGoogle,
    requireKey: true,
  },
  {
    name: "mistral", envKey: "MISTRAL_API_KEY",
    factory: (apiKey, baseURL) => createMistral({ apiKey, baseURL }),
    testModel: "mistral-small-latest", defaultModels: [],
    defaultBaseURL: "https://api.mistral.ai/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "xai", envKey: "XAI_API_KEY",
    factory: (apiKey, baseURL) => createXai({ apiKey, baseURL }),
    testModel: "grok-2-latest", defaultModels: [],
    defaultBaseURL: "https://api.x.ai/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "groq", envKey: "GROQ_API_KEY",
    factory: (apiKey, baseURL) => createGroq({ apiKey, baseURL }),
    testModel: "llama-3.3-70b-versatile", defaultModels: [],
    defaultBaseURL: "https://api.groq.com/openai/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "cerebras", envKey: "CEREBRAS_API_KEY",
    factory: (apiKey, baseURL) => createCerebras({ apiKey, baseURL }),
    testModel: "llama3.1-70b", defaultModels: [],
    defaultBaseURL: "https://api.cerebras.ai/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "deepseek", envKey: "DEEPSEEK_API_KEY",
    factory: (apiKey, baseURL) => createDeepSeek({ apiKey, baseURL }),
    testModel: "deepseek-chat", defaultModels: [],
    defaultBaseURL: "https://api.deepseek.com",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "togetherai", envKey: "TOGETHER_AI_API_KEY",
    factory: (apiKey, baseURL) => createTogetherAI({ apiKey, baseURL }),
    testModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", defaultModels: [],
    defaultBaseURL: "https://api.together.xyz/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "fireworks", envKey: "FIREWORKS_API_KEY",
    factory: (apiKey, baseURL) => createFireworks({ apiKey, baseURL }),
    testModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", defaultModels: [],
    defaultBaseURL: "https://api.fireworks.ai/inference/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },
  {
    name: "perplexity", envKey: "PERPLEXITY_API_KEY",
    factory: (apiKey, baseURL) => createPerplexity({ apiKey, baseURL }),
    testModel: "sonar",
    // Perplexity doesn't expose a public list-models endpoint.
    defaultModels: ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"],
    requireKey: true,
  },
  {
    name: "cohere", envKey: "COHERE_API_KEY",
    factory: (apiKey, baseURL) => createCohere({ apiKey, baseURL }),
    testModel: "command-r-plus", defaultModels: [],
    defaultBaseURL: "https://api.cohere.com",
    listModels: listModelsCohere, requireKey: true,
  },

  // === OpenAI-compatible: cloud, key required ===
  {
    name: "openrouter", envKey: "OPENROUTER_API_KEY",
    factory: (apiKey, baseURL) => createOpenAI({ apiKey, baseURL: baseURL ?? "https://openrouter.ai/api/v1" }),
    testModel: "auto", defaultModels: [],
    defaultBaseURL: "https://openrouter.ai/api/v1",
    listModels: listModelsOpenAIStyle, requireKey: true,
  },

  // === OpenAI-compatible: local, no key required ===
  // These only register when the user configured their baseURL (a local
  // server defaults to one of the sane ports below but is still opt-in
  // — we don't want to probe nonexistent localhost services at every
  // brain start).
  {
    name: "lm-studio", envKey: "LMSTUDIO_BASE_URL",
    factory: (_apiKey, baseURL) => createOpenAI({ apiKey: "lm-studio", baseURL: baseURL ?? "http://localhost:1234/v1" }),
    testModel: "auto", defaultModels: [],
    defaultBaseURL: "http://localhost:1234/v1",
    listModels: listModelsOpenAIStyle, requireKey: false,
  },
  {
    name: "vllm", envKey: "VLLM_BASE_URL",
    factory: (_apiKey, baseURL) => createOpenAI({ apiKey: "vllm", baseURL: baseURL ?? "http://localhost:8000/v1" }),
    testModel: "auto", defaultModels: [],
    defaultBaseURL: "http://localhost:8000/v1",
    listModels: listModelsOpenAIStyle, requireKey: false,
  },
  {
    name: "localai", envKey: "LOCALAI_BASE_URL",
    factory: (_apiKey, baseURL) => createOpenAI({ apiKey: "localai", baseURL: baseURL ?? "http://localhost:8080/v1" }),
    testModel: "auto", defaultModels: [],
    defaultBaseURL: "http://localhost:8080/v1",
    listModels: listModelsOpenAIStyle, requireKey: false,
  },
];
