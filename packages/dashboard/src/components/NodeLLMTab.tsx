import { useCallback, useEffect, useState } from "react";
import {
  getLLMModels,
  getLLMResolutionForNode,
  patchNodeConfig,
  type LLMModelChoice,
  type LLMResolutionPreview,
} from "../api/client";

interface NodeLLMTabProps {
  nodeId: string;
  currentModelOverride?: string;
  onAction: () => void;
}

function noop(): void { /* best-effort */ }

/**
 * Per-node LLM panel. Shows the currently-resolved model + provider,
 * lets the user either inherit the global default or pick a specific
 * `provider/model`. The actual setting lives in `config_overrides.model`
 * and is shipped to the existing PATCH /nodes/:id/config endpoint, so
 * nothing about the persistence path is new.
 */
export function NodeLLMTab({ nodeId, currentModelOverride, onAction }: NodeLLMTabProps): React.ReactElement {
  const [models, setModels] = useState<LLMModelChoice[]>([]);
  const [resolution, setResolution] = useState<LLMResolutionPreview | null>(null);
  const [draft, setDraft] = useState<string>(currentModelOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    getLLMModels().then(setModels).catch(noop);
    getLLMResolutionForNode(nodeId).then(setResolution).catch(noop);
  }, [nodeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setDraft(currentModelOverride ?? "");
  }, [currentModelOverride]);

  const save = useCallback((): void => {
    setSaving(true);
    setError(null);
    // null clears the field server-side (existing PATCH /config semantic);
    // an empty string means "use the global default" so we send null.
    const next = draft.trim() === "" ? null : draft.trim();
    patchNodeConfig(nodeId, { model: next })
      .then(() => {
        onAction();
        refresh();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, [draft, nodeId, onAction, refresh]);

  const layerLabel: Record<string, string> = {
    "node-override": "from this node's override",
    "global-default": "from the global default",
    "fallback": "from the framework fallback chain",
    "explicit": "explicit per-call",
  };

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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || draft === (currentModelOverride ?? "")}
          className="px-3 py-1 rounded bg-accent text-bg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-node-stopped text-xs">{error}</span>}
      </div>

      <div className="text-xs text-text-muted">
        Models are resolved in order: this node's override → global default → framework fallback chain.
        Changes apply on the node's next LLM call — no restart needed.
      </div>
    </div>
  );
}
