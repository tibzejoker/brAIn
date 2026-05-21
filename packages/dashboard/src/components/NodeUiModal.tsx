import { useEffect, useState } from "react";
import type { HubRef } from "../api/types";
import { reachableHubBase } from "../api/hub-reach";

interface NodeUiModalProps {
  nodeId: string;
  nodeName: string;
  /** The hub that owns this node (guest mode). When set, the UI is served
   *  by that machine — we probe its candidate IPs for one we can reach and
   *  point the iframe there. Undefined for local nodes → same-origin. */
  ownerHub?: HubRef;
  onClose: () => void;
}

export function NodeUiModal({ nodeId, nodeName, ownerHub, onClose }: NodeUiModalProps): React.ReactElement {
  // null = still probing the owner hub's reachable IP; "" = local/same-origin.
  const [base, setBase] = useState<string | null>(ownerHub ? null : "");

  useEffect(() => {
    if (!ownerHub) { setBase(""); return; }
    let cancelled = false;
    setBase(null);
    void reachableHubBase(ownerHub).then((b) => { if (!cancelled) setBase(b ?? ""); });
    return () => { cancelled = true; };
  }, [ownerHub]);

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
      {base === null ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
          Reaching {ownerHub?.hub_label ?? "host"}…
        </div>
      ) : (
        <iframe
          src={`${base}/nodes/${nodeId}/ui/`}
          className="flex-1 w-full border-none"
          title={`${nodeName} UI`}
        />
      )}
    </div>
  );
}
