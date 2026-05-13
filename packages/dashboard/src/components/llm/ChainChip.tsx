/**
 * A chip in the LLM fallback-chain editor.
 * Shows `provider/model` text with up / down / × controls.
 */
export function ChainChip({
  spec, canMoveUp, canMoveDown, onUp, onDown, onRemove,
}: {
  spec: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-text">
      <button
        type="button"
        onClick={onUp}
        disabled={!canMoveUp}
        title="Move earlier in chain"
        className="text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={!canMoveDown}
        title="Move later in chain"
        className="text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
      >
        ↓
      </button>
      <span>{spec}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Remove from chain"
        className="ml-1 text-text-muted hover:text-node-stopped"
      >
        ×
      </button>
    </span>
  );
}
