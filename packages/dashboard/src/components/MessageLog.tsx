import { useRef, useEffect } from "react";
import type { Message } from "../api/types";

interface MessageLogProps {
  messages: Message[];
  topicFilter: string;
  onTopicFilterChange: (v: string) => void;
  minCriticality: number;
  onMinCriticalityChange: (v: number) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function critColor(crit: number): string {
  if (crit >= 7) return "text-crit-high";
  if (crit >= 4) return "text-crit-mid";
  return "text-crit-low";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function payloadText(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "content" in payload) {
    return (payload as { content: string }).content;
  }
  if (typeof payload === "object" && payload !== null && "title" in payload) {
    return (payload as { title: string }).title;
  }
  return JSON.stringify(payload);
}

export function MessageLog({
  messages,
  topicFilter,
  onTopicFilterChange,
  minCriticality,
  onMinCriticalityChange,
}: MessageLogProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div className="flex flex-col border-t border-border bg-surface-raised h-48">
      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border text-xs">
        <span className="text-text-muted font-medium">Messages</span>
        <input
          type="text"
          placeholder="Filter topic..."
          value={topicFilter}
          onChange={(e) => onTopicFilterChange(e.target.value)}
          className="px-2 py-1 rounded bg-surface-overlay border border-border text-text text-xs w-40 focus:outline-none focus:border-accent"
        />
        <label className="flex items-center gap-1 text-text-muted">
          Min crit:
          <select
            value={minCriticality}
            onChange={(e) => onMinCriticalityChange(Number(e.target.value))}
            className="px-1 py-0.5 rounded bg-surface-overlay border border-border text-text text-xs focus:outline-none"
          >
            {Array.from({ length: 11 }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-text-muted">
          {messages.length} messages
        </span>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-1">
        {messages.length === 0 && (
          <div className="text-text-muted text-xs py-4 text-center">
            No messages yet
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className="flex items-baseline gap-2 py-0.5 text-xs font-mono"
          >
            <span className="text-text-muted shrink-0">
              {formatTime(msg.timestamp)}
            </span>
            <span className={`shrink-0 w-4 text-center font-bold ${critColor(msg.criticality)}`}>
              {msg.criticality}
            </span>
            <span className="text-accent shrink-0 truncate max-w-[140px]">
              {msg.topic}
            </span>
            <span className="text-text-muted shrink-0">
              from:{msg.from.slice(0, 8)}
            </span>
            <span className="text-text truncate">
              {truncate(payloadText(msg.payload), 80)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
