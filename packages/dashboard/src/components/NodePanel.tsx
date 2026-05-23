import { useCallback, useState, useEffect, useRef } from "react";
import type { NodeSnapshot } from "../api/types";
import { killNode, stopNode, startNode, getNodeLogs, getNodeMailboxes, getNodeDeadLetters, type NodeLogEntry, type MailboxInfo, type DeadLetterEntry } from "../api/client";
import { DeadLetterTab } from "./DeadLetterTab";
import { NodeLLMTab } from "./NodeLLMTab";
import { TabButton, InfoRow, ActionButton } from "./NodePanelHelpers";

function noop(): void { /* best-effort */ }
type PanelTab = "info" | "logs" | "mailbox" | "dlq" | "llm";

interface NodePanelProps {
  node: NodeSnapshot;
  hasUi?: boolean;
  onOpenUi?: () => void;
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
  hasUi,
  onOpenUi,
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
  const [deadLetters, setDeadLetters] = useState<DeadLetterEntry[]>([]);

  // Poll the active tab's data source.
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
    if (tab === "dlq") {
      const poll = (): void => { getNodeDeadLetters(node.id).then(setDeadLetters).catch(noop); };
      poll();
      const iv = setInterval(poll, 4000);
      return (): void => { clearInterval(iv); };
    }
    return undefined;
  }, [tab, node.id]);

  // Always poll the DLQ count (cheap) so the tab badge stays up-to-date
  // even when the user is on Info / Logs / Mailbox.
  useEffect(() => {
    const refreshCount = (): void => {
      getNodeDeadLetters(node.id).then(setDeadLetters).catch(noop);
    };
    refreshCount();
    const iv = setInterval(refreshCount, 5000);
    return (): void => { clearInterval(iv); };
  }, [node.id]);

  // Auto-scroll logs
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="w-full md:w-96 border-l border-border bg-surface-raised flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-text truncate">{node.name}</h2>
          {node.transport === "remote" && (
            <span
              title={`Hosted on agent ${node.target_agent_id ?? "?"}`}
              className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent font-mono"
            >
              ⚯ remote
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasUi && onOpenUi && (
            <button
              onClick={onOpenUi}
              title="Open this node's web UI"
              className="px-2 py-0.5 text-[11px] rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors font-medium"
            >
              Open UI
            </button>
          )}
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <TabButton label="Info" active={tab === "info"} onClick={() => setTab("info")} />
        <TabButton label="Mailbox" active={tab === "mailbox"} onClick={() => setTab("mailbox")} />
        <TabButton label="Logs" active={tab === "logs"} onClick={() => setTab("logs")} />
        <TabButton
          label={deadLetters.length > 0 ? `DLQ (${deadLetters.length})` : "DLQ"}
          active={tab === "dlq"}
          onClick={() => setTab("dlq")}
          warn={deadLetters.length > 0}
        />
        {node.tags.includes("llm") && (
          <TabButton label="LLM" active={tab === "llm"} onClick={() => setTab("llm")} />
        )}
      </div>

      {/* Tab content */}
      {tab === "info" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          <div className="space-y-2">
            <InfoRow label="ID" value={node.id} mono />
            <InfoRow label="Type" value={node.type} />
            <InfoRow label="State" value={node.state} />
            <InfoRow label="Transport" value={node.transport} />
            {node.target_agent_id && <InfoRow label="Agent" value={node.target_agent_id} mono />}
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
          {mailboxes.map((mb) => {
            const cap = mb.capacity || 1;
            const fillPct = Math.min(100, Math.round((mb.total / cap) * 100));
            const fillColor =
              fillPct >= 90 ? "bg-node-stopped" :
              fillPct >= 70 ? "bg-node-sleeping" :
              "bg-node-active";
            return (
            <div key={mb.pattern} className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-accent">{mb.pattern}</span>
                <span className="text-[10px] text-text-muted">
                  {mb.unread} unread / {mb.total} of {mb.capacity}
                </span>
                {mb.dropped > 0 && (
                  <span
                    title={`${mb.dropped} message(s) evicted because the mailbox was full`}
                    className="text-[10px] text-node-stopped font-semibold"
                  >
                    · {mb.dropped} dropped
                  </span>
                )}
              </div>
              <div className="h-1 rounded bg-surface-overlay overflow-hidden mb-1">
                <div
                  className={`h-full transition-all ${fillColor}`}
                  style={{ width: `${fillPct}%` }}
                />
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
            );
          })}
        </div>
      )}

      {tab === "dlq" && <DeadLetterTab entries={deadLetters} />}

      {tab === "llm" && (
        <div className="flex-1 overflow-y-auto p-4">
          <NodeLLMTab
            nodeId={node.id}
            ownerHubId={node.owner_hub?.hub_id}
            currentModelOverride={node.config_overrides?.model as string | undefined}
            currentCliOverride={node.config_overrides?.cli as string | undefined}
            onAction={onAction}
          />
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
        <ActionButton label="Kill" variant="danger" loading={actionLoading} onClick={() => handleAction(() => killNode(node.id))} />
      </div>
    </div>
  );
}

