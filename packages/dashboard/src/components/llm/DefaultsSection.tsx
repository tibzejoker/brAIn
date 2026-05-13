import type { LLMModelChoice } from "../../api/client";
import { ChainChip } from "./ChainChip";

interface DefaultsSectionProps {
  models: LLMModelChoice[];
  addOptions: LLMModelChoice[];
  defaultDraft: string;
  chainDraft: string[];
  addChain: string;
  defaultDirty: boolean;
  chainDirty: boolean;
  saving: boolean;
  onDefaultChange: (v: string) => void;
  onAddToChain: (spec: string) => void;
  onMoveChain: (idx: number, dir: -1 | 1) => void;
  onRemoveFromChain: (spec: string) => void;
  onSave: () => void;
}

/**
 * Top section of the LLM settings page — global default model + the
 * ordered fallback chain editor (chips).
 */
export function DefaultsSection({
  models, addOptions,
  defaultDraft, chainDraft, addChain,
  defaultDirty, chainDirty, saving,
  onDefaultChange, onAddToChain, onMoveChain, onRemoveFromChain, onSave,
}: DefaultsSectionProps): React.ReactElement {
  return (
    <section className="rounded border border-border bg-surface-raised p-4 space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-text-muted">Defaults</h3>
      <div>
        <label htmlFor="default-model" className="block text-text-muted text-xs mb-1">
          Global default model
        </label>
        <select
          id="default-model"
          value={defaultDraft}
          onChange={(e) => onDefaultChange(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
        >
          <option value="">(no preference — start from the fallback chain)</option>
          {models.map((m) => (
            <option key={m.spec} value={m.spec}>{m.spec}</option>
          ))}
        </select>
      </div>

      <div>
        <div className="block text-text-muted text-xs mb-1">
          Fallback chain (tried in order if the default is unreachable)
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {chainDraft.length === 0 ? (
            <span className="text-[11px] text-text-muted italic">
              Chain is empty — add at least one reachable model.
            </span>
          ) : chainDraft.map((spec, i) => (
            <ChainChip
              key={spec}
              spec={spec}
              canMoveUp={i > 0}
              canMoveDown={i < chainDraft.length - 1}
              onUp={() => onMoveChain(i, -1)}
              onDown={() => onMoveChain(i, 1)}
              onRemove={() => onRemoveFromChain(spec)}
            />
          ))}
        </div>
        <select
          value={addChain}
          onChange={(e) => { onAddToChain(e.target.value); }}
          className="w-full bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
          disabled={addOptions.length === 0}
        >
          <option value="">
            {addOptions.length === 0
              ? "(no more reachable models to add)"
              : "+ add a model to the chain…"}
          </option>
          {addOptions.map((m) => (
            <option key={m.spec} value={m.spec}>{m.spec}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || (!defaultDirty && !chainDirty)}
          className="px-3 py-1 rounded bg-accent text-bg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save defaults"}
        </button>
        {(defaultDirty || chainDirty) && (
          <span className="text-[11px] text-node-sleeping">unsaved changes</span>
        )}
      </div>
    </section>
  );
}
