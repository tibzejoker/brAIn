import { useCallback, useEffect, useState } from "react";
import {
  getLLMModels,
  getLLMResolutionForNode,
  getCLIAgents,
  refreshCLIAgents,
  patchNodeConfig,
  type LLMModelChoice,
  type LLMResolutionPreview,
  type CLIAgentStatus,
} from "../api/client";

interface NodeLLMTabProps {
  nodeId: string;
  currentModelOverride?: string;
  currentCliOverride?: string;
  onAction: () => void;
}

function noop(): void { /* best-effort */ }

/**
 * Per-node LLM panel. Two independent levers:
 *
 *  1. **Model override** — which `provider/model` this node's `ctx.llm`
 *     text/tool/tools calls resolve to. Lives in `config_overrides.model`.
 *  2. **Agent CLI** — which installed agentic CLI (claude-code / codex /
 *     gemini) this node's `ctx.llm.agent()` delegates to. Lives in
 *     `config_overrides.cli`. We only let the user pick a CLI that's
 *     actually bound (detected on PATH); the rest are shown greyed with
 *     their install hint so it's obvious why they're unavailable.
 *
 * Both ship to the existing PATCH /nodes/:id/config endpoint — nothing
 * about the persistence path is new.
 */
export function NodeLLMTab({ nodeId, currentModelOverride, currentCliOverride, onAction }: NodeLLMTabProps): React.ReactElement {
  const [models, setModels] = useState<LLMModelChoice[]>([]);
  const [resolution, setResolution] = useState<LLMResolutionPreview | null>(null);
  const [clis, setClis] = useState<CLIAgentStatus[]>([]);
  const [modelDraft, setModelDraft] = useState<string>(currentModelOverride ?? "");
  const [cliDraft, setCliDraft] = useState<string>(currentCliOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [recheckingClis, setRecheckingClis] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    getLLMModels().then(setModels).catch(noop);
    getLLMResolutionForNode(nodeId).then(setResolution).catch(noop);
    getCLIAgents().then(setClis).catch(noop);
  }, [nodeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setModelDraft(currentModelOverride ?? "");
  }, [currentModelOverride]);

  useEffect(() => {
    setCliDraft(currentCliOverride ?? "");
  }, [currentCliOverride]);

  const dirty = modelDraft !== (currentModelOverride ?? "") || cliDraft !== (currentCliOverride ?? "");

  const save = useCallback((): void => {
    setSaving(true);
    setError(null);
    // Empty string → "inherit / none" → send null so PATCH clears the key.
    const patch: Record<string, string | null> = {
      model: modelDraft.trim() === "" ? null : modelDraft.trim(),
      cli: cliDraft.trim() === "" ? null : cliDraft.trim(),
    };
    patchNodeConfig(nodeId, patch)
      .then(() => {
        onAction();
        refresh();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, [modelDraft, cliDraft, nodeId, onAction, refresh]);

  const recheckClis = useCallback((): void => {
    setRecheckingClis(true);
    refreshCLIAgents()
      .then(setClis)
      .catch(noop)
      .finally(() => setRecheckingClis(false));
  }, []);

  const layerLabel: Record<string, string> = {
    "node-override": "from this node's override",
    "global-default": "from the global default",
    "fallback": "from the framework fallback chain",
    "explicit": "explicit per-call",
  };

  const availableClis = clis.filter((c) => c.available);
  const unavailableClis = clis.filter((c) => !c.available);

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded border border-border bg-bg p-3">
        <div className="text-text-muted text-xs uppercase tracking-wider mb-2">
          Currently resolves to
        </div>
        {resolution ? (
          <>
            <div className="font-mono text-text">
              {resolution.resolved}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {layerLabel[resolution.layer] ?? resolution.layer}
              {resolution.fell_back && (
                <span className="text-node-sleeping ml-2">
                  · fell back: {resolution.fallback_reason ?? "preferred model unavailable"}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="text-text-muted italic">loading…</div>
        )}
      </div>

      <div>
        <label htmlFor="llm-model-select" className="block text-text-muted text-xs uppercase tracking-wider mb-2">
          Model override for this node
        </label>
        <select
          id="llm-model-select"
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
        >
          <option value="">(use global default)</option>
          {models.map((m) => (
            <option key={m.spec} value={m.spec}>{m.spec}</option>
          ))}
        </select>
        {models.length === 0 && (
          <p className="text-xs text-text-muted mt-1 italic">
            No providers are currently reachable. Set up provider credentials in Settings → LLM.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label htmlFor="llm-cli-select" className="block text-text-muted text-xs uppercase tracking-wider">
            Agent CLI for this node
          </label>
          <button
            type="button"
            onClick={recheckClis}
            disabled={recheckingClis}
            className="text-xs text-text-muted hover:text-text disabled:opacity-40"
          >
            {recheckingClis ? "checking…" : "re-check"}
          </button>
        </div>
        <select
          id="llm-cli-select"
          value={cliDraft}
          onChange={(e) => setCliDraft(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
        >
          <option value="">(none — uses model calls)</option>
          {availableClis.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}{c.version ? ` · ${c.version}` : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted mt-1">
          Routes <code className="font-mono">ctx.llm.agent()</code> to an installed agentic CLI. The CLI runs its own
          tool loop in this node's sandbox.
        </p>
        {availableClis.length === 0 && (
          <p className="text-xs text-node-sleeping mt-1 italic">
            No CLI agents detected on PATH. Install one (e.g. claude-code), then “re-check”.
          </p>
        )}
        {unavailableClis.length > 0 && (
          <div className="mt-2 space-y-1">
            {unavailableClis.map((c) => (
              <div key={c.name} className="flex items-center gap-2 text-xs text-text-muted">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-node-stopped" />
                <span className="font-mono">{c.name}</span>
                <span className="opacity-60">not installed · </span>
                <code className="font-mono opacity-60">{c.installCommand}</code>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="px-3 py-1 rounded bg-accent text-accent-fg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-node-stopped text-xs">{error}</span>}
      </div>

      <div className="text-xs text-text-muted">
        Models resolve in order: this node's override → global default → framework fallback chain.
        The agent CLI is a separate, explicit choice. Changes apply on the node's next LLM call — no restart needed.
      </div>
    </div>
  );
}
