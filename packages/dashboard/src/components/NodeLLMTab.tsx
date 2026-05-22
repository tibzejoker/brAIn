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

// A node's "brain" is EITHER a model OR an agentic CLI — the framework drives
// both the same way, so we present one list. CLI choices are encoded with a
// `cli:` prefix in the <select> value; everything else is a model spec.
const CLI_PREFIX = "cli:";

/**
 * Per-node LLM panel. One unified picker: pick a model (provider/model) OR an
 * installed agentic CLI (claude/codex/gemini). The two are mutually exclusive
 * — selecting one clears the other. Persists to config_overrides.model /
 * config_overrides.cli via the existing PATCH /nodes/:id/config.
 */
export function NodeLLMTab({ nodeId, currentModelOverride, currentCliOverride, onAction }: NodeLLMTabProps): React.ReactElement {
  const [models, setModels] = useState<LLMModelChoice[]>([]);
  const [resolution, setResolution] = useState<LLMResolutionPreview | null>(null);
  const [clis, setClis] = useState<CLIAgentStatus[]>([]);
  // Single encoded value: "" | "<provider/model>" | "cli:<name>".
  const encode = (model?: string, cli?: string): string => (cli ? `${CLI_PREFIX}${cli}` : (model ?? ""));
  const [draft, setDraft] = useState<string>(encode(currentModelOverride, currentCliOverride));
  const [saving, setSaving] = useState(false);
  const [recheckingClis, setRecheckingClis] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    getLLMModels().then(setModels).catch(noop);
    getLLMResolutionForNode(nodeId).then(setResolution).catch(noop);
    getCLIAgents().then(setClis).catch(noop);
  }, [nodeId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    setDraft(encode(currentModelOverride, currentCliOverride));
  }, [currentModelOverride, currentCliOverride]);

  const current = encode(currentModelOverride, currentCliOverride);
  const dirty = draft !== current;

  const save = useCallback((): void => {
    setSaving(true);
    setError(null);
    // Decode the single value back into the two config keys; null clears.
    const patch = draft.startsWith(CLI_PREFIX)
      ? { cli: draft.slice(CLI_PREFIX.length), model: null }
      : { model: draft.trim() === "" ? null : draft.trim(), cli: null };
    patchNodeConfig(nodeId, patch)
      .then(() => { onAction(); refresh(); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, [draft, nodeId, onAction, refresh]);

  const recheckClis = useCallback((): void => {
    setRecheckingClis(true);
    refreshCLIAgents().then(setClis).catch(noop).finally(() => setRecheckingClis(false));
  }, []);

  const layerLabel: Record<string, string> = {
    "node-override": "from this node's override",
    "global-default": "from the global default",
    "fallback": "from the framework fallback chain",
    "explicit": "explicit per-call",
  };

  // Alphabetical by spec — provider comes first in "provider/model", so this
  // groups each provider's models together. CLIs sorted by name likewise.
  const sortedModels = [...models].sort((a, b) => a.spec.localeCompare(b.spec));
  const availableClis = clis.filter((c) => c.available).sort((a, b) => a.name.localeCompare(b.name));
  const unavailableClis = clis.filter((c) => !c.available).sort((a, b) => a.name.localeCompare(b.name));
  const cliSelected = draft.startsWith(CLI_PREFIX);

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded border border-border bg-bg p-3">
        <div className="text-text-muted text-xs uppercase tracking-wider mb-2">
          {cliSelected ? "Delegates to" : "Currently resolves to"}
        </div>
        {cliSelected ? (
          <div className="font-mono text-text">{draft.slice(CLI_PREFIX.length)} <span className="text-text-muted">· agentic CLI</span></div>
        ) : resolution ? (
          <>
            <div className="font-mono text-text">{resolution.resolved}</div>
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
        <div className="flex items-center justify-between mb-2">
          <label htmlFor="llm-model-select" className="block text-text-muted text-xs uppercase tracking-wider">
            Model or agent for this node
          </label>
          <button
            type="button"
            onClick={recheckClis}
            disabled={recheckingClis}
            className="text-xs text-text-muted hover:text-text disabled:opacity-40"
          >
            {recheckingClis ? "checking…" : "re-check CLIs"}
          </button>
        </div>
        <select
          id="llm-model-select"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
        >
          <option value="">(use global default model)</option>
          {sortedModels.length > 0 && (
            <optgroup label="Models">
              {sortedModels.map((m) => <option key={m.spec} value={m.spec}>{m.spec}</option>)}
            </optgroup>
          )}
          {availableClis.length > 0 && (
            <optgroup label="Agent CLIs">
              {availableClis.map((c) => (
                <option key={c.name} value={`${CLI_PREFIX}${c.name}`}>
                  {c.name} (CLI agent){c.version ? ` · ${c.version}` : ""}
                </option>
              ))}
            </optgroup>
          )}
          {/* Keep a saved-but-now-unavailable CLI selectable so it still shows. */}
          {cliSelected && !availableClis.some((c) => `${CLI_PREFIX}${c.name}` === draft) && (
            <option value={draft}>{draft.slice(CLI_PREFIX.length)} (CLI agent · offline)</option>
          )}
        </select>
        <p className="text-xs text-text-muted mt-1">
          A model uses <code className="font-mono">ctx.llm.text/tool/tools</code>; a CLI agent uses{" "}
          <code className="font-mono">ctx.llm.agent()</code> and runs its own tool loop in this node's sandbox.
        </p>
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
        Pick a model OR an agent CLI — they're mutually exclusive. Models resolve
        in order: this node's override → global default → framework fallback chain.
        Changes apply on the node's next LLM call — no restart needed.
      </div>
    </div>
  );
}
