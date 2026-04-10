import { useCallback, useState } from "react";
import type { NodeSnapshot } from "../api/types";
import { killNode, stopNode, startNode, wakeNode } from "../api/client";

interface NodePanelProps {
  node: NodeSnapshot;
  onClose: () => void;
  onAction: () => void;
}

export function NodePanel({
  node,
  onClose,
  onAction,
}: NodePanelProps): React.ReactElement {
  const [actionLoading, setActionLoading] = useState(false);

  const handleAction = useCallback(
    (action: () => Promise<unknown>): void => {
      setActionLoading(true);
      action()
        .then(() => {
          onAction();
        })
        .catch(() => {
          /* action failed */
        })
        .finally(() => {
          setActionLoading(false);
        });
    },
    [onAction],
  );

  return (
    <div className="w-80 border-l border-border bg-surface-raised flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text truncate">
          {node.name}
        </h2>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Info */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        <div className="space-y-2">
          <InfoRow label="ID" value={node.id} mono />
          <InfoRow label="Type" value={node.type} />
          <InfoRow label="State" value={node.state} />
          <InfoRow label="Transport" value={node.transport} />
          <InfoRow label="Authority" value={String(node.authority_level)} />
          <InfoRow label="Priority" value={String(node.priority)} />
          {node.spawned_by && (
            <InfoRow label="Spawned by" value={node.spawned_by} mono />
          )}
        </div>

        {/* Tags */}
        {node.tags.length > 0 && (
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wide">
              Tags
            </span>
            <div className="flex flex-wrap gap-1 mt-1">
              {node.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 text-xs rounded bg-surface-overlay text-text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Subscriptions */}
        {node.subscriptions.length > 0 && (
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wide">
              Subscriptions
            </span>
            <div className="mt-1 space-y-1">
              {node.subscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="px-2 py-1 text-xs rounded bg-surface-overlay text-text font-mono"
                >
                  {sub.pattern}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border flex flex-wrap gap-2">
        {node.state === "active" && (
          <ActionButton
            label="Stop"
            variant="warning"
            loading={actionLoading}
            onClick={() => handleAction(() => stopNode(node.id))}
          />
        )}
        {node.state === "stopped" && (
          <ActionButton
            label="Start"
            variant="success"
            loading={actionLoading}
            onClick={() => handleAction(() => startNode(node.id))}
          />
        )}
        {node.state === "sleeping" && (
          <ActionButton
            label="Wake"
            variant="success"
            loading={actionLoading}
            onClick={() => handleAction(() => wakeNode(node.id))}
          />
        )}
        <ActionButton
          label="Kill"
          variant="danger"
          loading={actionLoading}
          onClick={() => handleAction(() => killNode(node.id))}
        />
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text-muted shrink-0">{label}</span>
      <span
        className={`text-text truncate text-right ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function ActionButton({
  label,
  variant,
  loading,
  onClick,
}: {
  label: string;
  variant: "success" | "warning" | "danger";
  loading: boolean;
  onClick: () => void;
}): React.ReactElement {
  const colors = {
    success: "bg-node-active/20 text-node-active hover:bg-node-active/30",
    warning: "bg-node-sleeping/20 text-node-sleeping hover:bg-node-sleeping/30",
    danger: "bg-node-stopped/20 text-node-stopped hover:bg-node-stopped/30",
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${colors[variant]}`}
    >
      {label}
    </button>
  );
}
