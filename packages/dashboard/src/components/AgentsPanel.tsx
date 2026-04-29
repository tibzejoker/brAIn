import { useCallback, useEffect, useState } from "react";
import { getAgents, type AgentSnapshot } from "../api/client";

/**
 * Live list of brain-agents currently announcing on the shared bus.
 * Empty when the API runs in single-process mode (no NATS) or no
 * agent is connected yet. Each row shows the agent id / host / pid,
 * uptime, and the node types it has registered locally.
 */
export function AgentsPanel(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    getAgents()
      .then((data) => { setAgents(data); setError(null); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    // Announcements arrive every ~10 s upstream, so a 3 s poll keeps
    // the pane responsive without hammering the API.
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Agents</h2>
        <span className="text-xs text-text-muted">
          {agents.length} connected
        </span>
        <button
          onClick={refresh}
          className="ml-auto text-xs text-text-muted hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs bg-node-stopped/10 text-node-stopped">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="text-text-muted text-xs py-8 text-center">Loading…</div>
        )}

        {!loading && agents.length === 0 && !error && (
          <div className="text-text-muted text-xs py-8 px-5 text-center max-w-md mx-auto">
            No agents announcing. Either the API runs with the in-memory bus
            (no NATS) or no <code className="text-text">brain-agent</code>
            is connected. Set <code className="text-text">BRAIN_NATS_URL</code> on
            both sides to bring them onto the same bus.
          </div>
        )}

        {agents.map((a) => (
          <div
            key={a.agent_id}
            className="px-5 py-4 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-node-active" />
              <span className="text-sm font-medium text-text">{a.host}</span>
              <span className="text-xs text-text-muted font-mono">{a.agent_id}</span>
              <span className="ml-auto text-xs text-text-muted">
                pid {a.pid} · up {formatUptime(Date.now() - a.started_at)}
              </span>
            </div>

            <div className="flex flex-wrap gap-1 mb-1">
              {a.types.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 text-[11px] rounded bg-surface-overlay text-text-muted"
                >
                  {t}
                </span>
              ))}
            </div>

            <p className="text-[11px] text-text-muted font-mono">
              last seen {Math.round((Date.now() - a.ts) / 1000)} s ago
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
