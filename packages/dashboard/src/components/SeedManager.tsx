import { useState, useEffect, useCallback, useMemo } from "react";
import { getSeeds, applySeed, type SeedInfo } from "../api/client";
import { getMarketplaceSeeds, installMarketplaceSeed, type MarketplaceSeed } from "../api/store";

type Source = "local" | "marketplace";
interface UnifiedSeed {
  source: Source;
  name: string;
  description: string;
  tags: string[];
  needs?: string[];
  /** local only */
  local?: SeedInfo;
  /** marketplace only */
  market?: MarketplaceSeed;
  /** Already on disk (always true for local; for marketplace = installed flag). */
  onDisk: boolean;
}

function unify(local: SeedInfo[], market: MarketplaceSeed[]): UnifiedSeed[] {
  const localNames = new Set(local.map((s) => s.name));
  const all: UnifiedSeed[] = local.map((s) => ({
    source: "local",
    name: s.name,
    description: extractDescription(s),
    tags: [],
    onDisk: true,
    local: s,
  }));
  for (const m of market) {
    if (localNames.has(m.name)) {
      // Already local — annotate with marketplace metadata for richer UI.
      const existing = all.find((s) => s.name === m.name);
      if (existing) {
        existing.tags = m.tags ?? [];
        existing.needs = m.needs;
        existing.market = m;
      }
      continue;
    }
    all.push({
      source: "marketplace",
      name: m.name,
      description: m.description,
      tags: m.tags ?? [],
      needs: m.needs,
      onDisk: false,
      market: m,
    });
  }
  return all;
}

function extractDescription(s: SeedInfo): string {
  // SeedInfo doesn't carry a description; fall back to the filename.
  return s.filename;
}

function matchesQuery(seed: UnifiedSeed, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (seed.name.toLowerCase().includes(needle)) return true;
  if (seed.description.toLowerCase().includes(needle)) return true;
  if (seed.tags.some((t) => t.toLowerCase().includes(needle))) return true;
  if (seed.needs?.some((n) => n.toLowerCase().includes(needle))) return true;
  return false;
}

export function SeedManager({ onApplied }: { onApplied: () => void }): React.ReactElement {
  const [local, setLocal] = useState<SeedInfo[]>([]);
  const [market, setMarket] = useState<MarketplaceSeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    void Promise.all([
      getSeeds().catch(() => [] as SeedInfo[]),
      getMarketplaceSeeds().catch(() => [] as MarketplaceSeed[]),
    ])
      .then(([l, m]) => { setLocal(l); setMarket(m); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleApply = useCallback((name: string): void => {
    setApplying(name);
    setResult(null);
    applySeed(name)
      .then((res) => {
        const parts = [
          `${res.spawned} spawned`,
          res.skipped > 0 ? `${res.skipped} skipped` : null,
          res.installed.length > 0 ? `installed: ${res.installed.join(", ")}` : null,
        ].filter(Boolean).join(" · ");
        setResult({ type: "success", message: `Applied "${name}" — ${parts}` });
        onApplied();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setResult({ type: "error", message: msg });
      })
      .finally(() => setApplying(null));
  }, [onApplied]);

  const handleInstall = useCallback((name: string): void => {
    setInstalling(name);
    setResult(null);
    installMarketplaceSeed(name)
      .then((res) => {
        setResult({ type: "success", message: `Pulled "${name}" from marketplace — ${res.message}` });
        refresh();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setResult({ type: "error", message: msg });
      })
      .finally(() => setInstalling(null));
  }, [refresh]);

  const unified = useMemo(() => unify(local, market), [local, market]);
  const filtered = useMemo(() => unified.filter((s) => matchesQuery(s, query)), [unified, query]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Seeds</h2>
        <span className="text-xs text-text-muted">
          {local.length} local · {market.length} marketplace
        </span>
        <input
          type="text"
          placeholder="Search by name, description, tag, or required type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 max-w-md ml-auto px-2 py-1 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text"
        />
        <button onClick={refresh} className="text-xs text-text-muted hover:text-text">Refresh</button>
      </div>

      {result && (
        <div className={`px-5 py-2 text-xs ${
          result.type === "success" ? "bg-node-active/10 text-node-active" : "bg-node-stopped/10 text-node-stopped"
        }`}>
          {result.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="text-text-muted text-xs py-8 text-center">Loading…</div>}

        {filtered.map((seed) => (
          <SeedCard
            key={`${seed.source}-${seed.name}`}
            seed={seed}
            applying={applying}
            installing={installing}
            onApply={handleApply}
            onInstall={handleInstall}
          />
        ))}

        {!loading && filtered.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            {query ? `No seeds match "${query}"` : "No seeds local or in the marketplace."}
          </div>
        )}
      </div>
    </div>
  );
}

interface SeedCardProps {
  seed: UnifiedSeed;
  applying: string | null;
  installing: string | null;
  onApply: (name: string) => void;
  onInstall: (name: string) => void;
}

function SeedCard({ seed, applying, installing, onApply, onInstall }: SeedCardProps): React.ReactElement {
  const isLocal = seed.onDisk;
  const local = seed.local;
  const fromMarket = seed.market;
  const valid = local?.valid ?? true;

  return (
    <div className="px-5 py-4 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${
          isLocal && valid ? "bg-node-active"
          : isLocal ? "bg-node-stopped"
          : "bg-text-muted/40"
        }`} />
        <span className="text-sm font-medium text-text">{seed.name}</span>
        <span className={`px-1.5 py-0.5 text-[10px] rounded ${
          isLocal ? "bg-node-active/10 text-node-active" : "bg-accent/15 text-accent"
        }`}>
          {isLocal ? "local" : "marketplace"}
        </span>
        {seed.tags.map((t) => (
          <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">
            {t}
          </span>
        ))}
        {local && (
          <span className="ml-auto text-xs text-text-muted">{local.node_count} nodes</span>
        )}
      </div>

      <p className="text-xs text-text-muted mb-2">{seed.description}</p>

      {seed.needs && seed.needs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-2 text-[11px]">
          <span className="text-text-muted">needs:</span>
          {seed.needs.map((n) => (
            <code key={n} className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">{n}</code>
          ))}
        </div>
      )}

      {local?.valid && local.nodes.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {local.nodes.map((n) => (
            <span key={n.name} className="px-2 py-0.5 text-[11px] rounded bg-surface-overlay text-text-muted">
              {n.name} ({n.type})
            </span>
          ))}
        </div>
      )}

      {local && !local.valid && local.errors.length > 0 && (
        <div className="mb-2 space-y-1">
          {local.errors.map((err, i) => (
            <div key={i} className="text-xs text-node-stopped bg-node-stopped/10 rounded px-2 py-1 font-mono">
              {err.line !== undefined && <span className="text-node-stopped/70">line {err.line}: </span>}
              {err.message}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {isLocal ? (
          <button
            onClick={() => onApply(seed.name)}
            disabled={!valid || applying !== null}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              valid ? "bg-accent/20 text-accent hover:bg-accent/30"
                    : "bg-surface-overlay text-text-muted cursor-not-allowed"
            } disabled:opacity-50`}
          >
            {applying === seed.name ? "Applying…" : "Apply seed"}
          </button>
        ) : (
          <button
            onClick={() => onInstall(seed.name)}
            disabled={installing !== null}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-bg hover:bg-accent/90 disabled:opacity-50"
          >
            {installing === seed.name ? "Pulling…" : "Pull from marketplace"}
          </button>
        )}
        {fromMarket && (
          <span className="text-[10px] text-text-muted font-mono">
            {fromMarket.repo}@{fromMarket.ref.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  );
}
