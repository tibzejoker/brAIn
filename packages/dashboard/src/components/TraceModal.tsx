import { useEffect, useState } from "react";
import { getTrace } from "../api/client";
import type { Message } from "../api/types";

interface TraceModalProps {
  traceId: string;
  nodeNames: Map<string, string>;
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  });
}

function critColor(crit: number): string {
  if (crit >= 7) return "text-crit-high";
  if (crit >= 4) return "text-crit-mid";
  return "text-crit-low";
}

function payloadText(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "content" in payload) {
    return (payload as { content: string }).content;
  }
  return JSON.stringify(payload);
}

/**
 * Build a depth lookup from the parent_id chain so the renderer can
 * indent each message under the one that caused it. Roots (no parent
 * inside the trace) sit at depth 0; orphans get depth 0 too.
 */
function depthOf(msgs: Message[]): Map<string, number> {
  const byId = new Map(msgs.map((m) => [m.id, m] as const));
  const cache = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (cache.has(id)) {
      const cached = cache.get(id);
      return cached ?? 0;
    }
    if (seen.has(id)) return 0;
    seen.add(id);
    const m = byId.get(id);
    const parent = m?.parent_id;
    const d = parent && byId.has(parent) ? compute(parent, seen) + 1 : 0;
    cache.set(id, d);
    return d;
  };
  for (const m of msgs) compute(m.id, new Set());
  return cache;
}

export function TraceModal({ traceId, nodeNames, onClose }: TraceModalProps): React.ReactElement {
  const [chain, setChain] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTrace(traceId)
      .then((c) => { if (!cancelled) setChain(c); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) setError(msg);
      });
    return (): void => { cancelled = true; };
  }, [traceId]);

  const depths = chain ? depthOf(chain) : new Map<string, number>();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border rounded-lg w-[760px] max-h-[80vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold text-text">Causal trace</h2>
            <span className="text-xs text-text-muted font-mono truncate">{traceId}</span>
            {chain && (
              <span className="text-xs text-text-muted">· {chain.length} message{chain.length > 1 ? "s" : ""}</span>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {!chain && !error && (
            <div className="text-text-muted text-xs py-8 text-center">Loading…</div>
          )}
          {error && (
            <div className="text-xs text-node-stopped bg-node-stopped/10 rounded px-3 py-2">{error}</div>
          )}
          {chain?.length === 0 && (
            <div className="text-text-muted text-xs py-8 text-center">Trace empty.</div>
          )}
          {chain?.map((m) => {
            const d = depths.get(m.id) ?? 0;
            return (
              <div
                key={m.id}
                className="py-1 border-b border-border/30 last:border-0"
                style={{ paddingLeft: `${d * 16}px` }}
              >
                <div className="flex items-baseline gap-2 text-[11px] font-mono">
                  <span className="text-text-muted shrink-0">{formatTime(m.timestamp)}</span>
                  <span className={`shrink-0 w-4 text-center font-bold ${critColor(m.criticality)}`}>
                    {m.criticality}
                  </span>
                  <span className="text-accent shrink-0 truncate max-w-[180px]">{m.topic}</span>
                  <span className="text-text-muted shrink-0">
                    {nodeNames.get(m.from) ?? m.from}
                  </span>
                  {m.parent_id && (
                    <span className="text-text-muted/60 shrink-0" title={`parent ${m.parent_id}`}>↳</span>
                  )}
                </div>
                <div className="text-[11px] text-text font-mono truncate ml-6">
                  {payloadText(m.payload)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
