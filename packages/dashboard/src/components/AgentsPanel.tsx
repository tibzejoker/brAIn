import { useCallback, useEffect, useState } from "react";
import { getAgents, getTransport, type AgentSnapshot } from "../api/client";

/**
 * Distributed runtime panel. The bus is always NATS — embedded by
 * default, or external when `BRAIN_NATS_URL` is set on the API.
 * This pane shows the broker URL (so remote `brain-agent` instances
 * know what to connect to) and the hosts currently announcing on it.
 *
 * UI-side we call them "remote nodes" since users think of the unit
 * of brAIn work as a node — code-side they're `Agent`s, hosts that
 * happen to run nodes for us.
 */
export function AgentsPanel(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [transport, setTransport] = useState<{ url: string | null; mode: "embedded" | "external" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    Promise.all([getAgents(), getTransport()])
      .then(([data, t]) => { setAgents(data); setTransport(t); setError(null); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Distributed</h2>
        <span className="text-xs text-text-muted">
          {agents.length} remote node{agents.length === 1 ? "" : "s"} connected
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

      {transport && <TransportInfo transport={transport} />}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="text-text-muted text-xs py-8 text-center">Loading…</div>
        )}

        {!loading && agents.length === 0 && !error && (
          <div className="text-text-muted text-xs py-6 px-5 text-center max-w-md mx-auto">
            No remote nodes yet. Run the snippet above on the target
            machine to join this bus.
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

function TransportInfo({ transport }: { transport: { url: string | null; mode: "embedded" | "external" } }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  // Embedded brokers bind to 127.0.0.1 — only reachable from the same
  // host. Remote nodes need a network-routable URL, so we surface the
  // localhost snippet but flag the constraint.
  const localOnly = transport.mode === "embedded"
    && (transport.url?.includes("127.0.0.1") || transport.url?.includes("localhost"));

  const snippet = transport.url
    ? `BRAIN_NATS_URL=${transport.url} \\\nBRAIN_NODES_DIR=./nodes \\\nnpx brain-agent`
    : "";

  const onCopy = (): void => {
    if (!snippet) return;
    void navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="px-5 py-3 border-b border-border bg-surface-raised/40">
      <div className="flex items-center gap-2 mb-2 text-xs text-text-muted">
        <span>Broker</span>
        <code className="text-text font-mono">{transport.url ?? "—"}</code>
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
          transport.mode === "embedded" ? "bg-accent/15 text-accent" : "bg-node-active/10 text-node-active"
        }`}>
          {transport.mode}
        </span>
      </div>
      {localOnly && (
        <p className="text-[11px] text-text-muted mb-2">
          Embedded broker on 127.0.0.1 — only reachable from this host. To bring
          nodes from another machine, set <code className="text-text">BRAIN_NATS_URL</code> on
          the API to a network-routable broker.
        </p>
      )}
      {snippet && !localOnly && (
        <div className="flex items-start gap-2">
          <pre className="flex-1 text-[11px] font-mono bg-surface-overlay px-2 py-1.5 rounded text-text overflow-x-auto whitespace-pre">{snippet}</pre>
          <button
            onClick={onCopy}
            className="text-xs text-text-muted hover:text-text whitespace-nowrap"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      )}
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
