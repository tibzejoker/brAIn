import { useState, useEffect, useCallback } from "react";
import { getNetworkHistory, type HistoryEntry } from "../api/client";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const ACTION_COLORS: Record<string, string> = {
  "node.spawned": "text-node-active",
  "node.killed": "text-node-stopped",
  "node.stopped": "text-node-sleeping",
  "node.started": "text-node-active",
  "node.woken": "text-accent",
  "network.seeded": "text-accent",
  "network.reset": "text-node-stopped",
};

function parseDetails(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function HistoryPanel(): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  const refresh = useCallback((): void => {
    setLoading(true);
    getNetworkHistory({ last: 100 })
      .then((data) => {
        setEntries(data);
      })
      .catch(() => { /* silent */ })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return (): void => { clearInterval(interval); };
  }, [refresh]);

  const filtered = filter
    ? entries.filter((e) =>
        e.action.includes(filter) ||
        (e.node_name?.includes(filter) ?? false) ||
        (e.node_type?.includes(filter) ?? false),
      )
    : entries;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Network History</h2>
        <input
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-2 py-1 rounded bg-surface-overlay border border-border text-text text-xs w-40 focus:outline-none focus:border-accent"
        />
        <button
          onClick={refresh}
          className="ml-auto text-xs text-text-muted hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && entries.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">Loading...</div>
        )}

        {filtered.map((entry) => {
          const details = parseDetails(entry.details);
          return (
            <div
              key={entry.id}
              className="px-5 py-3 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-text-muted font-mono">
                  {formatTime(entry.timestamp)}
                </span>
                <span className={`text-xs font-medium ${ACTION_COLORS[entry.action] ?? "text-text"}`}>
                  {entry.action}
                </span>
              </div>

              {entry.node_name && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text font-medium">{entry.node_name}</span>
                  {entry.node_type && (
                    <span className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">
                      {entry.node_type}
                    </span>
                  )}
                </div>
              )}

              {Object.keys(details).length > 0 && (
                <div className="mt-1 text-[11px] text-text-muted font-mono truncate">
                  {JSON.stringify(details)}
                </div>
              )}
            </div>
          );
        })}

        {!loading && filtered.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            No history entries
          </div>
        )}
      </div>
    </div>
  );
}
