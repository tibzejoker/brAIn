import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getCLIAgents,
  getLLMConfig,
  getLLMModels,
  getLLMProviders,
  patchLLMConfig,
  refreshCLIAgents,
  type CLIAgentStatus,
  type LLMGlobalConfig,
  type LLMModelChoice,
  type LLMProviderStatus,
} from "../api/client";
import { DefaultsSection } from "./llm/DefaultsSection";
import { ProviderCard } from "./llm/ProviderCard";
import { CLIAgentCard } from "./llm/CLIAgentCard";

/**
 * Project-wide LLM settings page.
 *
 *  1. Defaults — global default model + fallback chain (chip list).
 *  2. Providers — one card per provider with API key + base URL inputs.
 *
 * Auto-prune: any chain entry pointing at a model whose provider is no
 * longer reachable gets dropped on the next refresh (and the cleaned
 * chain is persisted automatically). This keeps the chain meaningful
 * after a key is removed or a provider is reset.
 */
export function LLMSettingsPanel(): React.ReactElement {
  const [cfg, setCfg] = useState<LLMGlobalConfig | null>(null);
  const [models, setModels] = useState<LLMModelChoice[]>([]);
  const [providers, setProviders] = useState<LLMProviderStatus[]>([]);
  const [clis, setClis] = useState<CLIAgentStatus[]>([]);
  const [refreshingClis, setRefreshingClis] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Search
  const [search, setSearch] = useState("");

  // Drafts (uncommitted user input)
  const [editKeys, setEditKeys] = useState<Record<string, string>>({});
  const [editBaseURLs, setEditBaseURLs] = useState<Record<string, string>>({});
  const [defaultDraft, setDefaultDraft] = useState<string>("");
  const [chainDraft, setChainDraft] = useState<string[]>([]);
  const [addChain, setAddChain] = useState<string>("");
  const [prunedNotice, setPrunedNotice] = useState<string | null>(null);

  const refresh = useCallback((): Promise<void> => {
    setLoadError(null);
    return Promise.all([getLLMConfig(), getLLMModels(), getLLMProviders(), getCLIAgents()])
      .then(([c, m, p, agents]) => {
        setClis(agents);
        // Auto-prune: drop chain entries whose model isn't currently
        // reachable. Persist the cleaned chain back so on-disk + memory
        // stay consistent without the user clicking Save.
        const reachable = new Set(m.map((mm) => mm.spec));
        const pruned = c.fallbackChain.filter((spec) => reachable.has(spec));
        const dropped = c.fallbackChain.filter((spec) => !reachable.has(spec));

        setCfg({ ...c, fallbackChain: pruned });
        setModels(m);
        setProviders(p);
        setDefaultDraft(c.defaultModel ?? "");
        setChainDraft(pruned);
        setLoading(false);

        if (dropped.length > 0) {
          setPrunedNotice(`Dropped from chain (provider unreachable): ${dropped.join(", ")}`);
          void patchLLMConfig({ fallbackChain: pruned });
        } else {
          setPrunedNotice(null);
        }
      })
      .catch((err: Error) => {
        setLoadError(err.message || String(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // "Add to chain" dropdown options: every reachable model not already in the chain.
  const addOptions = useMemo<LLMModelChoice[]>(() => {
    const inChain = new Set(chainDraft);
    return models.filter((m) => !inChain.has(m.spec));
  }, [models, chainDraft]);

  // Search filter — matches against provider names AND the model names
  // inside each provider. A provider card stays visible if EITHER the
  // provider name OR any of its models contains the query.
  const visibleProviders = useMemo<LLMProviderStatus[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.models.some((m) => m.toLowerCase().includes(q)),
    );
  }, [providers, search]);
  const visibleCLIs = useMemo<CLIAgentStatus[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clis;
    return clis.filter((c) => c.name.toLowerCase().includes(q));
  }, [clis, search]);

  const saveDefaults = useCallback((): void => {
    setSavingKey("defaults");
    void patchLLMConfig({
      defaultModel: defaultDraft.trim() || undefined,
      fallbackChain: chainDraft,
    })
      .then(() => { void refresh(); })
      .finally(() => { setSavingKey(null); });
  }, [defaultDraft, chainDraft, refresh]);

  const saveProvider = useCallback((provider: string): void => {
    setSavingKey(provider);
    const patch: { apiKey?: string; baseURL?: string } = {};
    if (provider in editKeys) patch.apiKey = editKeys[provider].trim() || undefined;
    if (provider in editBaseURLs) patch.baseURL = editBaseURLs[provider].trim() || undefined;
    // The API now awaits the registry re-probe before responding, so by
    // the time refresh() reads /llm/providers the new statuses are live.
    void patchLLMConfig({ providers: { [provider]: patch } })
      .then(() => {
        setEditKeys((prev) => { const n = { ...prev }; delete n[provider]; return n; });
        setEditBaseURLs((prev) => { const n = { ...prev }; delete n[provider]; return n; });
        void refresh();
      })
      .finally(() => { setSavingKey(null); });
  }, [editKeys, editBaseURLs, refresh]);

  const addToChain = useCallback((spec: string): void => {
    if (!spec || chainDraft.includes(spec)) return;
    setChainDraft([...chainDraft, spec]);
    setAddChain("");
  }, [chainDraft]);

  const removeFromChain = useCallback((spec: string): void => {
    setChainDraft(chainDraft.filter((s) => s !== spec));
  }, [chainDraft]);

  const moveChain = useCallback((idx: number, dir: -1 | 1): void => {
    const next = idx + dir;
    if (next < 0 || next >= chainDraft.length) return;
    const arr = [...chainDraft];
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    setChainDraft(arr);
  }, [chainDraft]);

  const chainDirty = cfg !== null && (
    chainDraft.length !== cfg.fallbackChain.length ||
    chainDraft.some((s, i) => s !== cfg.fallbackChain[i])
  );
  const defaultDirty = cfg !== null && defaultDraft !== (cfg.defaultModel ?? "");

  if (loading) {
    return <div className="p-6 text-text-muted">Loading LLM settings…</div>;
  }
  if (!cfg) {
    return (
      <div className="p-6 space-y-2">
        <div className="text-node-stopped font-semibold text-sm">Couldn't load LLM settings.</div>
        {loadError && <pre className="text-[11px] text-text-muted whitespace-pre-wrap">{loadError}</pre>}
        <button
          type="button"
          onClick={() => void refresh()}
          className="px-3 py-1 rounded bg-accent text-accent-fg text-xs font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  // max-w-3xl (~768px) caps the readable column on wide monitors —
  // provider cards stay legible instead of stretching across the full
  // right pane. mx-auto centers the column.
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6 text-sm min-w-0">
      <header className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-text mb-1">LLM Providers</h2>
          <p className="text-text-muted text-xs">
            Set the default model every node uses, configure provider credentials, and
            define a fallback chain for when a preferred model is unreachable.
            Changes apply on the next call — no restart needed.
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search providers or models (e.g. mistral, claude-haiku, llama)…"
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
      </header>

      {prunedNotice && (
        <div className="rounded border border-node-sleeping/40 bg-node-sleeping/10 px-3 py-2 text-[11px] text-node-sleeping">
          {prunedNotice}
        </div>
      )}

      <DefaultsSection
        models={models}
        addOptions={addOptions}
        defaultDraft={defaultDraft}
        chainDraft={chainDraft}
        addChain={addChain}
        defaultDirty={defaultDirty}
        chainDirty={chainDirty}
        saving={savingKey === "defaults"}
        onDefaultChange={setDefaultDraft}
        onAddToChain={addToChain}
        onMoveChain={moveChain}
        onRemoveFromChain={removeFromChain}
        onSave={saveDefaults}
      />

      <section className="space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-text-muted">
          Providers
          {search && (
            <span className="ml-2 normal-case tracking-normal text-text-muted">
              ({visibleProviders.length} of {providers.length} match "{search}")
            </span>
          )}
        </h3>
        {providers.length === 0 && (
          <p className="text-[11px] text-text-muted italic">
            No providers registered yet. The framework still registers Ollama by
            default — if you don't see it, the registry hasn't initialised.
          </p>
        )}
        {search && visibleProviders.length === 0 && (
          <p className="text-[11px] text-text-muted italic">
            No provider matches "{search}".
          </p>
        )}
        {visibleProviders.map((p) => (
          <ProviderCard
            key={p.name}
            provider={p}
            saving={savingKey === p.name}
            draftKey={editKeys[p.name]}
            draftBaseURL={editBaseURLs[p.name]}
            onDraftKeyChange={(v) => setEditKeys((prev) => ({ ...prev, [p.name]: v }))}
            onDraftBaseURLChange={(v) => setEditBaseURLs((prev) => ({ ...prev, [p.name]: v }))}
            onSave={() => saveProvider(p.name)}
          />
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wider text-text-muted">CLI Agents</h3>
          <button
            type="button"
            onClick={() => {
              setRefreshingClis(true);
              void refreshCLIAgents()
                .then(setClis)
                .finally(() => setRefreshingClis(false));
            }}
            disabled={refreshingClis}
            className="px-2 py-0.5 rounded border border-border text-[10px] text-text-muted hover:text-text disabled:opacity-40"
          >
            {refreshingClis ? "Re-checking…" : "Re-check"}
          </button>
        </div>
        <p className="text-[11px] text-text-muted">
          Agentic CLIs that run their own internal tool loops. Auth is interactive
          (browser flow) — run the install + login commands in your own terminal,
          then click Re-check.
        </p>
        {search && visibleCLIs.length === 0 && (
          <p className="text-[11px] text-text-muted italic">
            No CLI agent matches "{search}".
          </p>
        )}
        {visibleCLIs.map((agent) => (
          <CLIAgentCard key={agent.name} agent={agent} />
        ))}
      </section>
      </div>
    </div>
  );
}
