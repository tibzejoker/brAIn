interface NodeUiModalProps {
  nodeId: string;
  nodeName: string;
  onClose: () => void;
}

export function NodeUiModal({ nodeId, nodeName, onClose }: NodeUiModalProps): React.ReactElement {
  const src = `/nodes/${nodeId}/ui/`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80">
      <div className="flex items-center justify-between px-5 py-3 bg-surface-raised border-b border-border">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text">{nodeName}</h2>
          <span className="px-2 py-0.5 text-[10px] rounded bg-accent/20 text-accent">UI</span>
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-lg leading-none px-2"
        >
          &times;
        </button>
      </div>
      <iframe
        src={src}
        className="flex-1 w-full border-none"
        title={`${nodeName} UI`}
      />
    </div>
  );
}
