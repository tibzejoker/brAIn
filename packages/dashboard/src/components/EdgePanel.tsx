import { useEffect, useState, useRef, useCallback } from "react";
import type { Message, NodeSnapshot } from "../api/types";
import { getMessages, unbindPortTopic } from "../api/client";
import { onMessagePublished } from "../api/socket";

interface EdgePanelProps {
  sourceId: string;
  targetId: string;
  topics: string[];
  /** Subscriber-side input port whose binding produced this edge. When
   *  present, EdgePanel surfaces a delete-link button that unbinds it.
   *  Absent for legacy / dynamic edges where we can't identify a port. */
  subPortName?: string;
  nodes: NodeSnapshot[];
  onClose: () => void;
  /** Called after a successful unbind so App re-fetches the graph. */
  onWiringChanged?: () => void;
}

const MAX_EDGE_MESSAGES = 50;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function payloadPreview(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "content" in payload) {
    const content = (payload as { content: string }).content;
    return content.length > 120 ? `${content.slice(0, 120)}...` : content;
  }
  const str = JSON.stringify(payload);
  return str.length > 120 ? `${str.slice(0, 120)}...` : str;
}

function matchWildcard(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function EdgePanel({
  sourceId,
  targetId,
  topics,
  subPortName,
  nodes,
  onClose,
  onWiringChanged,
}: EdgePanelProps): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sourceName = nodes.find((n) => n.id === sourceId)?.name ?? sourceId.slice(0, 8);
  const targetName = nodes.find((n) => n.id === targetId)?.name ?? targetId.slice(0, 8);

  // The edge's topic is the publisher's concrete output; the subscriber's
  // input port might hold either that exact string or a wildcard matching
  // it (e.g. `alerts.*` covering `alerts.alert`). Unbinding requires the
  // ACTUAL binding string stored in port_bindings, so we look it up.
  const subscriber = nodes.find((n) => n.id === targetId);
  const subBindings = subPortName
    ? subscriber?.port_bindings?.inputs?.[subPortName] ?? []
    : [];
  const edgeTopic = topics[0] ?? "";
  const bindingsToRemove = subBindings.filter((b) => matchWildcard(b, edgeTopic));
  const canDelete = Boolean(subPortName) && bindingsToRemove.length > 0;

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!subPortName || bindingsToRemove.length === 0) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // Multiple bindings may match (rare but possible — e.g. both
      // `chat.response` and `chat.response.*` on the same port). Unbind
      // every match so the edge fully disappears.
      for (const b of bindingsToRemove) {
        await unbindPortTopic(targetId, "inputs", subPortName, b);
      }
      onWiringChanged?.();
      onClose();
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [subPortName, targetId, bindingsToRemove, onWiringChanged, onClose]);

  // Seed from history on mount
  useEffect(() => {
    getMessages({ last: 100 })
      .then((all) => {
        const relevant = all.filter((m) =>
          m.from === sourceId && topics.some((t) => matchWildcard(t, m.topic)),
        );
        setMessages(relevant.slice(-MAX_EDGE_MESSAGES));
      })
      .catch(() => { /* silent */ });
  }, [sourceId, topics]);

  // Live updates via socket
  useEffect(() => {
    return onMessagePublished((msg) => {
      if (msg.from !== sourceId) return;
      const matches = topics.some((t) => matchWildcard(t, msg.topic));
      if (!matches) return;
      setMessages((prev) => [...prev.slice(-(MAX_EDGE_MESSAGES - 1)), msg]);
    });
  }, [sourceId, topics]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div className="w-full md:w-96 border-l border-border bg-surface-raised flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-text">
            {sourceName} → {targetName}
          </span>
          <span className="text-xs text-text-muted mt-0.5">
            {topics.join(", ")}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Live messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            Waiting for messages on this edge...
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className="py-2 border-b border-border/50 last:border-0"
          >
            <div className="flex items-center gap-2 text-xs mb-1">
              <span className="text-text-muted font-mono">
                {formatTime(msg.timestamp)}
              </span>
              <span className="text-accent">{msg.topic}</span>
              <span className="ml-auto text-text-muted">
                crit:{msg.criticality}
              </span>
            </div>
            <div className="text-xs text-text font-mono bg-surface-overlay rounded px-2 py-1.5 break-all">
              {payloadPreview(msg.payload)}
            </div>
          </div>
        ))}
      </div>

      {/* Footer: message count + delete-link button */}
      <div className="px-4 py-2 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">
          {messages.length} messages captured
        </span>
        {canDelete && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-xs px-2 py-1 rounded border border-node-stopped/40 text-node-stopped hover:bg-node-stopped/10 disabled:opacity-50"
            title={`Unbind ${bindingsToRemove.join(", ")} from ${targetName}'s ${subPortName} port`}
          >
            {deleting ? "Removing..." : "Delete link"}
          </button>
        )}
      </div>
      {deleteError && (
        <div className="px-4 py-2 border-t border-border text-xs text-node-stopped">
          {deleteError}
        </div>
      )}
    </div>
  );
}
