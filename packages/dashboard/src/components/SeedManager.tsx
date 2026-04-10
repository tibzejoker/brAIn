import { useState, useEffect, useCallback } from "react";
import { getSeeds, applySeed, type SeedInfo } from "../api/client";

export function SeedManager({ onApplied }: { onApplied: () => void }): React.ReactElement {
  const [seeds, setSeeds] = useState<SeedInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    getSeeds()
      .then((data) => {
        setSeeds(data);
      })
      .catch(() => { /* silent */ })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleApply = useCallback((name: string): void => {
    setApplying(name);
    setResult(null);

    applySeed(name)
      .then((res) => {
        setResult({ type: "success", message: `Applied "${name}": ${res.seeded} nodes spawned` });
        onApplied();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setResult({ type: "error", message: msg });
      })
      .finally(() => {
        setApplying(null);
      });
  }, [onApplied]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Seed Configs</h2>
        <span className="text-xs text-text-muted">{seeds.length} available</span>
        <button
          onClick={refresh}
          className="ml-auto text-xs text-text-muted hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Result banner */}
      {result && (
        <div
          className={`px-5 py-2 text-xs ${
            result.type === "success"
              ? "bg-node-active/10 text-node-active"
              : "bg-node-stopped/10 text-node-stopped"
          }`}
        >
          {result.message}
        </div>
      )}

      {/* Seeds list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="text-text-muted text-xs py-8 text-center">Loading...</div>
        )}

        {seeds.map((seed) => (
          <div
            key={seed.name}
            className="px-5 py-4 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${seed.valid ? "bg-node-active" : "bg-node-stopped"}`} />
              <span className="text-sm font-medium text-text">{seed.name}</span>
              <span className="text-xs text-text-muted">{seed.filename}</span>
              <span className="ml-auto text-xs text-text-muted">
                {seed.node_count} nodes
              </span>
            </div>

            {/* Node preview */}
            {seed.valid && seed.nodes.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {seed.nodes.map((n) => (
                  <span
                    key={n.name}
                    className="px-2 py-0.5 text-[11px] rounded bg-surface-overlay text-text-muted"
                  >
                    {n.name} ({n.type})
                  </span>
                ))}
              </div>
            )}

            {/* Validation errors */}
            {!seed.valid && seed.errors.length > 0 && (
              <div className="mb-2 space-y-1">
                {seed.errors.map((err, i) => (
                  <div
                    key={i}
                    className="text-xs text-node-stopped bg-node-stopped/10 rounded px-2 py-1 font-mono"
                  >
                    {err.line !== undefined && (
                      <span className="text-node-stopped/70">line {err.line}: </span>
                    )}
                    {err.message}
                  </div>
                ))}
              </div>
            )}

            {/* Apply button */}
            <button
              onClick={() => handleApply(seed.name)}
              disabled={!seed.valid || applying !== null}
              className={`
                px-3 py-1.5 text-xs font-medium rounded-md transition-colors
                ${seed.valid
                  ? "bg-accent/20 text-accent hover:bg-accent/30"
                  : "bg-surface-overlay text-text-muted cursor-not-allowed"}
                disabled:opacity-50
              `}
            >
              {applying === seed.name ? "Applying..." : "Apply seed"}
            </button>
          </div>
        ))}

        {!loading && seeds.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            No seed files found in seeds/ directory
          </div>
        )}
      </div>
    </div>
  );
}
