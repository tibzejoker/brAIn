import { useEffect, useState, useRef } from "react";
import type { Message, NodeSnapshot } from "../api/types";
import { onMessagePublished } from "../api/socket";

interface EdgePanelProps {
  sourceId: string;
  targetId: string;
  topics: string[];
  nodes: NodeSnapshot[];
  onClose: () => void;
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
  nodes,
  onClose,
}: EdgePanelProps): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sourceName = nodes.find((n) => n.id === sourceId)?.name ?? sourceId.slice(0, 8);
  const targetName = nodes.find((n) => n.id === targetId)?.name ?? targetId.slice(0, 8);

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
    <div className="w-96 border-l border-border bg-surface-raised flex flex-col overflow-hidden">
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

      {/* Footer stats */}
      <div className="px-4 py-2 border-t border-border text-xs text-text-muted">
        {messages.length} messages captured
      </div>
    </div>
  );
}
