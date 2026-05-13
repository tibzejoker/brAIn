/**
 * Project-level LLM config — the source of truth for:
 *
 *  - the global default model (used when a node doesn't override)
 *  - the framework fallback chain (used when the preferred model isn't
 *    reachable in the running registry)
 *  - per-provider credentials (API keys + base URLs)
 *
 * Persisted to `<dataRoot>/llm-config.json` with mode 0o600 so the file
 * holds secrets safely on a multi-user box. The loader merges, in
 * priority order: this file > process.env > built-in defaults — so
 * environment variables still work for users who prefer them, and a
 * fresh install with no config + no env works as long as Ollama is up.
 *
 * Mutations go through `updateConfig()` which writes atomically and
 * fires a callback the LLMRegistry uses to re-probe providers without
 * a server restart.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProviderCredentials {
  /** API key. Empty / absent means "fall back to env, then disabled." */
  apiKey?: string;
  /** Base URL — only meaningful for Ollama / OpenAI-compatible servers. */
  baseURL?: string;
}

export interface LLMConfig {
  /** "provider/model" — preferred model used when nothing overrides. */
  defaultModel?: string;
  /** Ordered list of "provider/model" strings tried after defaultModel. */
  fallbackChain: string[];
  /** Keyed by provider name (anthropic, openai, google, ollama, …). */
  providers: Record<string, ProviderCredentials>;
}

/** Sane built-in fallback chain — points at the always-reachable Ollama
 *  default first so a clean install Just Works without any API keys. */
const BUILTIN_FALLBACK: string[] = [
  "ollama/gemma4:e4b",
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-4-5-20251001",
];

export class LLMConfigStore {
  private readonly cfg: LLMConfig;
  private readonly filePath: string;
  private readonly listeners = new Set<(c: LLMConfig) => void>();

  constructor(dataRoot: string) {
    this.filePath = path.join(dataRoot, "llm-config.json");
    this.cfg = this.load();
  }

  /** Resolve the config that callers should consume. File > env > builtin. */
  private load(): LLMConfig {
    let fromFile: Partial<LLMConfig> = {};
    try {
      if (fs.existsSync(this.filePath)) {
        fromFile = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<LLMConfig>;
      }
    } catch {
      // Corrupted file — leave the in-memory defaults, don't crash the
      // whole bus on a bad JSON. The dashboard will surface the issue.
    }

    const fileProviders: Partial<Record<string, ProviderCredentials>> = fromFile.providers ?? {};
    const providers: Record<string, ProviderCredentials> = {
      anthropic: {
        apiKey: fileProviders.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY,
      },
      openai: {
        apiKey: fileProviders.openai?.apiKey ?? process.env.OPENAI_API_KEY,
      },
      google: {
        apiKey: fileProviders.google?.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      },
      ollama: {
        baseURL: fileProviders.ollama?.baseURL ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      },
    };

    return {
      defaultModel: fromFile.defaultModel,
      fallbackChain: fromFile.fallbackChain && fromFile.fallbackChain.length > 0
        ? fromFile.fallbackChain
        : [...BUILTIN_FALLBACK],
      providers,
    };
  }

  get(): LLMConfig {
    return this.cfg;
  }

  /** Read-only snapshot with API keys redacted, for dashboard GET endpoints. */
  getRedacted(): LLMConfig {
    const redact = (k?: string): string | undefined => {
      if (!k) return undefined;
      if (k.length <= 4) return "*".repeat(k.length);
      return "*".repeat(Math.max(4, k.length - 4)) + k.slice(-4);
    };
    return {
      defaultModel: this.cfg.defaultModel,
      fallbackChain: [...this.cfg.fallbackChain],
      providers: Object.fromEntries(
        Object.entries(this.cfg.providers).map(([name, p]) => [
          name,
          { apiKey: redact(p.apiKey), baseURL: p.baseURL },
        ]),
      ),
    };
  }

  /** Apply a partial update + persist atomically + notify listeners. */
  update(patch: Partial<LLMConfig>): LLMConfig {
    if (patch.defaultModel !== undefined) this.cfg.defaultModel = patch.defaultModel || undefined;
    if (patch.fallbackChain !== undefined) this.cfg.fallbackChain = [...patch.fallbackChain];
    if (patch.providers) {
      for (const [name, creds] of Object.entries(patch.providers)) {
        // Merge per-provider — an empty/undefined value clears the field
        // (so the dashboard can wipe a key by saving "").
        const next = { ...this.cfg.providers[name] };
        if ("apiKey" in creds) next.apiKey = creds.apiKey || undefined;
        if ("baseURL" in creds) next.baseURL = creds.baseURL || undefined;
        this.cfg.providers[name] = next;
      }
    }
    this.persist();
    for (const cb of this.listeners) {
      try { cb(this.cfg); } catch { /* listener bugs shouldn't break writes */ }
    }
    return this.cfg;
  }

  /** Subscribe to config changes — used by LLMRegistry to re-probe. */
  onChange(cb: (c: LLMConfig) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      // Ensure mode is locked down even if a re-create raced.
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
    } catch {
      // We don't want a bad disk to crash the runtime — the in-memory
      // state still drives behaviour. Dashboard write endpoints can
      // surface the failure separately if they want to.
    }
  }
}
