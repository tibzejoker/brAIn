import type { HubRef } from "../api/types";

interface NodeUiModalProps {
  nodeId: string;
  nodeName: string;
  /** The hub that owns this node — kept for the label only. The iframe is
   *  ALWAYS served by the local framework at `/node/<id>/ui/`; cross-machine
   *  hops go through NATS, so the dashboard never reaches another host's
   *  HTTP directly (no IP probing, no port juggling). */
  ownerHub?: HubRef;
  onClose: () => void;
}

export function NodeUiModal({ nodeId, nodeName, ownerHub, onClose }: NodeUiModalProps): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80">
      <div className="flex items-center justify-between px-5 py-3 bg-surface-raised border-b border-border">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text">{nodeName}</h2>
          <span className="px-2 py-0.5 text-[10px] rounded bg-accent/20 text-accent">UI</span>
          {ownerHub && (
            <span className="px-2 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">
              {ownerHub.hub_label}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-lg leading-none px-2"
        >
          &times;
        </button>
      </div>
      <iframe
        src={`/node/${nodeId}/ui/`}
        className="flex-1 w-full border-none"
        title={`${nodeName} UI`}
      />
    </div>
  );
}
