import type { LLMProviderStatus } from "../../api/client";

interface ProviderCardProps {
  provider: LLMProviderStatus;
  saving: boolean;
  draftKey?: string;
  draftBaseURL?: string;
  onDraftKeyChange: (v: string) => void;
  onDraftBaseURLChange: (v: string) => void;
  onSave: () => void;
}

/**
 * One card per LLM provider. Renders status + API key + base URL inputs,
 * with the unified Save button publishing both edits in one PATCH.
 *
 * Base URL is available for EVERY provider (not just Ollama) — useful
 * for OpenAI-compatible gateways (OpenRouter, vLLM, LM Studio, LocalAI,
 * Portkey…), regional endpoints, or self-hosted Anthropic proxies.
 */
export function ProviderCard({
  provider, saving,
  draftKey, draftBaseURL,
  onDraftKeyChange, onDraftBaseURLChange,
  onSave,
}: ProviderCardProps): React.ReactElement {
  const requiresKey = provider.name !== "ollama";
  const dirty = draftKey !== undefined || draftBaseURL !== undefined;

  return (
    <div className="rounded border border-border bg-surface-raised p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${provider.available ? "bg-node-active" : "bg-node-stopped"}`} />
          <span className="font-semibold text-text capitalize">{provider.name}</span>
          {provider.available ? (
            <span className="text-[10px] text-node-active uppercase tracking-wider">reachable</span>
          ) : (
            <span className="text-[10px] text-node-stopped uppercase tracking-wider">unavailable</span>
          )}
        </div>
        <span className="text-[10px] text-text-muted">{provider.models.length} model(s)</span>
      </div>

      {provider.error && !provider.available && (
        <p className="text-[11px] text-node-stopped break-words">{provider.error}</p>
      )}

      {requiresKey && (
        <div>
          <label htmlFor={`${provider.name}-key`} className="block text-text-muted text-xs mb-1">
            API key
          </label>
          <input
            id={`${provider.name}-key`}
            type="password"
            value={draftKey ?? ""}
            onChange={(e) => onDraftKeyChange(e.target.value)}
            placeholder={provider.apiKey ?? "(no key set)"}
            className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
          />
          <p className="text-[10px] text-text-muted mt-1">
            {provider.apiKey
              ? `Currently: ${provider.apiKey} — leave blank then Save to clear, or enter a new key to replace.`
              : "Paste the API key. Stored locally in data/llm-config.json (mode 0o600)."}
          </p>
        </div>
      )}

      <div>
        <label htmlFor={`${provider.name}-base`} className="block text-text-muted text-xs mb-1">
          Base URL{" "}
          {requiresKey && (
            <span className="text-text-muted italic">(optional — for gateways or proxies)</span>
          )}
        </label>
        <input
          id={`${provider.name}-base`}
          type="text"
          value={draftBaseURL ?? provider.baseURL ?? ""}
          onChange={(e) => onDraftBaseURLChange(e.target.value)}
          placeholder={
            provider.name === "ollama"
              ? "http://localhost:11434"
              : `https://api.${provider.name}.com (default)`
          }
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
        />
        {provider.name === "ollama" ? (
          <p className="text-[10px] text-text-muted mt-1">
            Point this at a non-default port or a remote Ollama host if needed.
          </p>
        ) : (
          <p className="text-[10px] text-text-muted mt-1">
            Override only for OpenAI-compatible gateways (OpenRouter, vLLM, LM Studio, LocalAI, Portkey, etc.). Leave blank to use the SDK default.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="px-3 py-1 rounded bg-accent text-bg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && <span className="text-[11px] text-node-sleeping">unsaved</span>}
      </div>

      {provider.available && provider.models.length > 0 && (
        <details className="text-[11px] text-text-muted">
          <summary className="cursor-pointer select-none">Available models</summary>
          <ul className="mt-1 ml-3 list-disc list-inside font-mono">
            {provider.models.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
