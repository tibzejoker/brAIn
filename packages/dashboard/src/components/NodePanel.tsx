import { useCallback, useState, useEffect, useRef } from "react";
import type { NodeSnapshot } from "../api/types";
import { killNode, stopNode, startNode, wakeNode, tickNode, getNodeLogs, getNodeMailboxes, type NodeLogEntry, type MailboxInfo } from "../api/client";

function noop(): void { /* best-effort */ }
type PanelTab = "info" | "logs" | "mailbox";

interface NodePanelProps {
  node: NodeSnapshot;
  devMode: boolean;
  onClose: () => void;
  onAction: () => void;
}

const LOG_LEVEL_COLORS: Record<string, string> = {
  error: "text-node-stopped",
  warn: "text-node-sleeping",
  info: "text-text",
  debug: "text-text-muted",
};

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function NodePanel({
  node,
  devMode,
  onClose,
  onAction,
}: NodePanelProps): React.ReactElement {
  const [actionLoading, setActionLoading] = useState(false);
  const [tab, setTab] = useState<PanelTab>("info");
  const [logs, setLogs] = useState<NodeLogEntry[]>([]);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const handleAction = useCallback(
    (action: () => Promise<unknown>): void => {
      setActionLoading(true);
      action()
        .then(() => { onAction(); })
        .catch(() => { /* action failed */ })
        .finally(() => { setActionLoading(false); });
    },
    [onAction],
  );

  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);

  // Poll logs or mailboxes depending on active tab
  useEffect(() => {
    if (tab === "logs") {
      const poll = (): void => { getNodeLogs(node.id, 100).then(setLogs).catch(noop); };
      poll();
      const iv = setInterval(poll, 2000);
      return (): void => { clearInterval(iv); };
    }
    if (tab === "mailbox") {
      const poll = (): void => { getNodeMailboxes(node.id).then(setMailboxes).catch(noop); };
      poll();
      const iv = setInterval(poll, 3000);
      return (): void => { clearInterval(iv); };
    }
    return undefined;
  }, [tab, node.id]);

  // Auto-scroll logs
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="w-96 border-l border-border bg-surface-raised flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text truncate">{node.name}</h2>
        <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">
          &times;
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <TabButton label="Info" active={tab === "info"} onClick={() => setTab("info")} />
        <TabButton label="Mailbox" active={tab === "mailbox"} onClick={() => setTab("mailbox")} />
        <TabButton label="Logs" active={tab === "logs"} onClick={() => setTab("logs")} />
      </div>

      {/* Tab content */}
      {tab === "info" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          <div className="space-y-2">
            <InfoRow label="ID" value={node.id} mono />
            <InfoRow label="Type" value={node.type} />
            <InfoRow label="State" value={node.state} />
            <InfoRow label="Transport" value={node.transport} />
            <InfoRow label="Authority" value={String(node.authority_level)} />
            <InfoRow label="Priority" value={String(node.priority)} />
            {node.spawned_by && <InfoRow label="Spawned by" value={node.spawned_by} mono />}
          </div>

          {node.tags.length > 0 && (
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wide">Tags</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {node.tags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 text-xs rounded bg-surface-overlay text-text-muted">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {node.subscriptions.length > 0 && (
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wide">Subscriptions</span>
              <div className="mt-1 space-y-1">
                {node.subscriptions.map((sub) => (
                  <div key={sub.id} className="px-2 py-1 text-xs rounded bg-surface-overlay text-text font-mono">{sub.pattern}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "logs" && (
        <div ref={logScrollRef} className="flex-1 overflow-y-auto px-3 py-2">
          {logs.length === 0 && (
            <div className="text-text-muted text-xs py-8 text-center">No logs yet</div>
          )}
          {logs.map((entry, i) => (
            <div key={i} className="py-1 border-b border-border/30 last:border-0">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-text-muted font-mono">{formatLogTime(entry.timestamp)}</span>
                <span className={`font-medium uppercase ${LOG_LEVEL_COLORS[entry.level] ?? "text-text"}`}>
                  {entry.level}
                </span>
              </div>
              <div className={`text-xs font-mono mt-0.5 ${LOG_LEVEL_COLORS[entry.level] ?? "text-text"}`}>
                {entry.message}
              </div>
              {entry.data && Object.keys(entry.data).length > 0 && (
                <div className="text-[10px] text-text-muted font-mono mt-0.5 truncate">
                  {JSON.stringify(entry.data)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "mailbox" && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {mailboxes.length === 0 && (
            <div className="text-text-muted text-xs py-8 text-center">No mailboxes</div>
          )}
          {mailboxes.map((mb) => (
            <div key={mb.pattern} className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-accent">{mb.pattern}</span>
                <span className="text-[10px] text-text-muted">{mb.unread} unread / {mb.total} total</span>
              </div>
              {mb.messages.length === 0 && (
                <div className="text-text-muted text-[10px] pl-2">Empty</div>
              )}
              {mb.messages.map((m) => (
                <div key={m.id} className="pl-2 py-1 border-l-2 border-border/50 ml-1 mb-0.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="text-text-muted font-mono">{new Date(m.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <span className={`font-bold ${m.criticality >= 7 ? "text-crit-high" : m.criticality >= 4 ? "text-crit-mid" : "text-crit-low"}`}>{m.criticality}</span>
                    <span className="text-text-muted truncate">{m.topic}</span>
                  </div>
                  <div className="text-[10px] text-text font-mono truncate mt-0.5">{m.preview}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="p-4 border-t border-border flex flex-wrap gap-2">
        {node.state === "active" && (
          <ActionButton label="Stop" variant="warning" loading={actionLoading} onClick={() => handleAction(() => stopNode(node.id))} />
        )}
        {node.state === "stopped" && (
          <ActionButton label="Start" variant="success" loading={actionLoading} onClick={() => handleAction(() => startNode(node.id))} />
        )}
        {node.state === "sleeping" && (
          <ActionButton label="Wake" variant="success" loading={actionLoading} onClick={() => handleAction(() => wakeNode(node.id))} />
        )}
        <ActionButton label="Kill" variant="danger" loading={actionLoading} onClick={() => handleAction(() => killNode(node.id))} />
        {devMode && node.state === "active" && (
          <ActionButton label="Step" variant="success" loading={actionLoading} onClick={() => handleAction(() => tickNode(node.id))} />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium transition-colors ${
        active
          ? "text-accent border-b-2 border-accent"
          : "text-text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.ReactElement {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text-muted shrink-0">{label}</span>
      <span className={`text-text truncate text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function ActionButton({ label, variant, loading, onClick }: {
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
