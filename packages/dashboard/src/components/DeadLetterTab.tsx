import type { DeadLetterEntry } from "../api/client";

function dlqPreview(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "content" in payload) {
    return (payload as { content: string }).content;
  }
  return JSON.stringify(payload);
}

export function DeadLetterTab({ entries }: { entries: DeadLetterEntry[] }): React.ReactElement {
  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {entries.length === 0 && (
        <div className="text-text-muted text-xs py-8 text-center">
          No dead letters — the handler hasn't crashed on a message yet.
        </div>
      )}
      {entries.map((d, i) => (
        <div key={i} className="py-2 border-b border-border/30 last:border-0">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-text-muted font-mono">
              {new Date(d.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span className="text-accent truncate">{d.message.topic}</span>
            <span className="text-text-muted ml-auto truncate max-w-[150px]">{d.message.from}</span>
          </div>
          <div className="text-[11px] text-node-stopped font-mono mt-0.5 break-words">
            {d.error}
          </div>
          <div className="text-[10px] text-text-muted font-mono mt-0.5 truncate">
            {dlqPreview(d.message.payload)}
          </div>
        </div>
      ))}
    </div>
  );
}
