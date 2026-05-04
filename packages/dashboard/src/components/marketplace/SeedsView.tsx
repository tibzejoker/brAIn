import { useCallback, useEffect, useMemo, useState } from "react";
import { getSeeds, applySeed, type SeedInfo } from "../../api/client";
import { getMarketplaceSeeds, installMarketplaceSeed, type MarketplaceSeed } from "../../api/store";

interface UnifiedSeed {
  source: "local" | "marketplace";
  name: string;
  description: string;
  tags: string[];
  needs?: string[];
  local?: SeedInfo;
  market?: MarketplaceSeed;
  onDisk: boolean;
}

function unifySeeds(local: SeedInfo[], market: MarketplaceSeed[]): UnifiedSeed[] {
  const localNames = new Set(local.map((s) => s.name));
  const marketIndex = new Map(market.map((m) => [m.name, m]));
  const out: UnifiedSeed[] = [];
  for (const s of local) {
    const m = marketIndex.get(s.name);
    out.push({
      source: "local",
      name: s.name,
      description: m?.description ?? s.filename,
      tags: m?.tags ?? [],
      needs: m?.needs,
      onDisk: true, local: s, market: m,
    });
  }
  for (const m of market) {
    if (localNames.has(m.name)) continue;
    out.push({
      source: "marketplace", name: m.name, description: m.description,
      tags: m.tags ?? [], needs: m.needs, onDisk: false, market: m,
    });
  }
  return out;
}

export function SeedsView({ onChanged }: { onChanged: () => void }): React.ReactElement {
  const [local, setLocal] = useState<SeedInfo[]>([]);
  const [market, setMarket] = useState<MarketplaceSeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    void Promise.all([
      getSeeds().catch(() => [] as SeedInfo[]),
      getMarketplaceSeeds().catch(() => [] as MarketplaceSeed[]),
    ]).then(([l, m]) => { setLocal(l); setMarket(m); }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleApply = useCallback((name: string, merge: boolean): void => {
    setApplying(name); setBanner(null);
    applySeed(name, { merge })
      .then((res) => {
        const parts = [
          res.killed > 0 ? `${res.killed} replaced` : null,
          `${res.spawned} spawned`,
          res.skipped > 0 ? `${res.skipped} skipped` : null,
          res.installed.length > 0 ? `installed: ${res.installed.join(", ")}` : null,
        ].filter(Boolean).join(" · ");
        setBanner({ type: "success", message: `Applied "${name}" — ${parts}` });
        onChanged();
      })
      .catch((err: unknown) => setBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setApplying(null));
  }, [onChanged]);

  const handleInstall = useCallback((name: string): void => {
    setInstalling(name); setBanner(null);
    installMarketplaceSeed(name)
      .then((res) => { setBanner({ type: "success", message: `Pulled "${name}" — ${res.message}` }); refresh(); })
      .catch((err: unknown) => setBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setInstalling(null));
  }, [refresh]);

  const all = useMemo(() => unifySeeds(local, market), [local, market]);
  const filtered = useMemo(() => all.filter((s) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
      || s.tags.some((t) => t.toLowerCase().includes(q))
      || (s.needs?.some((n) => n.toLowerCase().includes(q)) ?? false);
  }), [all, query]);

  const localCount = all.filter((s) => s.onDisk).length;
  const marketCount = all.filter((s) => !s.onDisk).length;

  return (
    <>
      <div className="flex items-center gap-3 px-5 py-2 border-b border-border bg-surface-raised/50">
        <span className="text-xs text-text-muted">
          {localCount} installed · {marketCount} available
        </span>
        <input
          type="text"
          placeholder="Search seeds, tags, needs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 max-w-md ml-auto px-2 py-1 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text"
        />
        <button onClick={refresh} className="text-xs text-text-muted hover:text-text">Refresh</button>
      </div>

      {banner && (
        <div className={`px-5 py-2 text-xs ${
          banner.type === "success" ? "bg-node-active/10 text-node-active" : "bg-node-stopped/10 text-node-stopped"
        }`}>{banner.message}</div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="text-text-muted text-xs py-8 text-center">Loading…</div>}
        {filtered.map((s) => (
          <SeedCard
            key={`${s.source}-${s.name}`} seed={s}
            applying={applying === s.name} installing={installing === s.name}
            onApply={(merge) => handleApply(s.name, merge)} onInstall={() => handleInstall(s.name)}
          />
        ))}
        {!loading && filtered.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            {query ? `No seeds match "${query}"` : "No seeds anywhere."}
          </div>
        )}
      </div>
    </>
  );
}

function SeedCard({ seed, applying, installing, onApply, onInstall }: {
  seed: UnifiedSeed; applying: boolean; installing: boolean;
  onApply: (merge: boolean) => void; onInstall: () => void;
}): React.ReactElement {
  const valid = seed.local?.valid ?? true;
  return (
    <div className="px-5 py-4 border-b border-border/50">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${
          seed.onDisk && valid ? "bg-node-active"
          : seed.onDisk ? "bg-node-stopped" : "bg-text-muted/40"
        }`} />
        <span className="text-sm font-medium text-text">{seed.name}</span>
        <span className={`px-1.5 py-0.5 text-[10px] rounded ${
          seed.onDisk ? "bg-node-active/10 text-node-active" : "bg-accent/15 text-accent"
        }`}>
          {seed.onDisk ? "installed" : "marketplace"}
        </span>
        {seed.tags.map((t) => (
          <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">{t}</span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {seed.onDisk ? (
            <>
              <button
                onClick={() => onApply(true)}
                disabled={!valid || applying}
                title="Spawn this seed's nodes alongside the running network — names that already exist are skipped."
                className="px-2 py-1 text-xs rounded text-text-muted hover:text-text disabled:opacity-50"
              >
                Add only
              </button>
              <button
                onClick={() => onApply(false)}
                disabled={!valid || applying}
                title="Replace the running network with this seed's nodes (DB tables survive)."
                className={`px-3 py-1 text-xs rounded ${
                  valid ? "bg-accent text-bg hover:bg-accent/90" : "bg-surface-overlay text-text-muted cursor-not-allowed"
                } disabled:opacity-50`}
              >
                {applying ? "Applying…" : "Apply (replace)"}
              </button>
            </>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing}
              className="px-3 py-1 text-xs rounded bg-accent text-bg hover:bg-accent/90 disabled:opacity-50"
            >
              {installing ? "Pulling…" : "Pull from marketplace"}
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-text-muted">{seed.description}</p>
      {seed.needs && seed.needs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5 text-[11px]">
          <span className="text-text-muted">needs:</span>
          {seed.needs.map((n) => (
            <code key={n} className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">{n}</code>
          ))}
        </div>
      )}
      {seed.market && (
        <div className="mt-1 text-[10px] text-text-muted font-mono">
          {seed.market.repo}@{seed.market.ref.slice(0, 8)}
        </div>
      )}
    </div>
  );
}
