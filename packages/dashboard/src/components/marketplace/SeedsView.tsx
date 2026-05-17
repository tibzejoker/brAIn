import { useCallback, useMemo, useState } from "react";
import {
  applySeed,
  deletePersonalSeed,
  savePersonalSeed,
  type SeedInfo,
} from "../../api/client";
import { installMarketplaceSeed, type MarketplaceSeed } from "../../api/store";
import { useMarketplace } from "../../hooks/useMarketplace";

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
  const { data, loading, refetch } = useMarketplace();
  const [applying, setApplying] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const handleSaveCurrent = useCallback((): void => {
    // Native prompt keeps the new feature truly minimal — no modal
    // component to maintain. We can swap to a styled dialog later.
    const raw = window.prompt("Name this personal seed:");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    setSaving(true); setBanner(null);
    savePersonalSeed(name)
      .then((res) => {
        setBanner({ type: "success", message: `Saved as personal seed "${res.slug}"` });
        void refetch();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Collision: offer overwrite in a follow-up confirm — keeps
        // the UI single-flow without a custom dialog.
        if (/already exists/i.test(message)) {
          if (window.confirm(`"${name}" already exists. Overwrite?`)) {
            savePersonalSeed(name, { overwrite: true })
              .then((res) => {
                setBanner({ type: "success", message: `Overwrote personal seed "${res.slug}"` });
                void refetch();
              })
              .catch((err2: unknown) => setBanner({
                type: "error", message: err2 instanceof Error ? err2.message : String(err2),
              }));
            return;
          }
        }
        setBanner({ type: "error", message });
      })
      .finally(() => setSaving(false));
  }, [refetch]);

  const handleDelete = useCallback((name: string): void => {
    if (!window.confirm(`Delete personal seed "${name}"? This is permanent.`)) return;
    setDeleting(name); setBanner(null);
    deletePersonalSeed(name)
      .then(() => { setBanner({ type: "success", message: `Deleted "${name}"` }); void refetch(); })
      .catch((err: unknown) => setBanner({
        type: "error", message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setDeleting(null));
  }, [refetch]);

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
        type: "error", message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setApplying(null));
  }, [onChanged]);

  const handleInstall = useCallback((name: string): void => {
    setInstalling(name); setBanner(null);
    installMarketplaceSeed(name)
      .then((res) => { setBanner({ type: "success", message: `Pulled "${name}" — ${res.message}` }); void refetch(); })
      .catch((err: unknown) => setBanner({
        type: "error", message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setInstalling(null));
  }, [refetch]);

  const all = useMemo(() => {
    if (!data) return [];
    return unifySeeds(data.localSeeds, data.marketplaceSeeds);
  }, [data]);

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
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-2 border-b border-border bg-surface-raised/50">
        <span className="text-xs text-text-muted shrink-0 whitespace-nowrap">
          {localCount} installed · {marketCount} available
        </span>
        <input
          type="text"
          placeholder="Search seeds, tags, needs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="order-last sm:order-none basis-full sm:basis-auto sm:flex-1 sm:max-w-md sm:ml-auto px-2 py-1 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text"
        />
        <button
          onClick={handleSaveCurrent}
          disabled={saving}
          title="Snapshot the running network as a new personal seed"
          className="shrink-0 px-2 py-1 text-xs rounded bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50 whitespace-nowrap"
        >
          {saving ? "Saving…" : "Save current"}
        </button>
        <button onClick={() => void refetch()} className="shrink-0 text-xs text-text-muted hover:text-text whitespace-nowrap">Refresh view</button>
      </div>

      {banner && (
        <div className={`px-5 py-2 text-xs ${
          banner.type === "success" ? "bg-node-active/10 text-node-active" : "bg-node-stopped/10 text-node-stopped"
        }`}>{banner.message}</div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && !data && <div className="text-text-muted text-xs py-8 text-center">Loading…</div>}
        {filtered.map((s) => (
          <SeedCard
            key={`${s.source}-${s.name}`} seed={s}
            applying={applying === s.name} installing={installing === s.name}
            deleting={deleting === s.name}
            onApply={(merge) => handleApply(s.name, merge)} onInstall={() => handleInstall(s.name)}
            onDelete={() => handleDelete(s.name)}
          />
        ))}
        {!loading && data && filtered.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            {query ? `No seeds match "${query}"` : "No seeds anywhere."}
          </div>
        )}
      </div>
    </>
  );
}

function SeedCard({ seed, applying, installing, deleting, onApply, onInstall, onDelete }: {
  seed: UnifiedSeed; applying: boolean; installing: boolean; deleting: boolean;
  onApply: (merge: boolean) => void; onInstall: () => void; onDelete: () => void;
}): React.ReactElement {
  const valid = seed.local?.valid ?? true;
  const missing = seed.local?.missing_types ?? [];
  const hasMissing = missing.length > 0;
  const isPersonal = seed.local?.source === "personal";
  // The "ready to spawn" state requires:
  //   - the seed lives on disk locally,
  //   - the YAML is syntactically valid,
  //   - and every node type it references is registered. Missing
  //     types don't make the seed invalid, but they DO make it
  //     unspawnable, so we gate the Apply buttons here too.
  const canApply = seed.onDisk && valid && !hasMissing;
  const applyTitle = !valid
    ? `Invalid seed — fix YAML errors first`
    : hasMissing
      ? `Missing node types: ${missing.join(", ")} — install the project(s) that ship them, then retry.`
      : undefined;

  return (
    <div className="px-4 sm:px-5 py-4 border-b border-border/50">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span className={`shrink-0 w-2 h-2 rounded-full ${
          canApply ? "bg-node-active"
          : seed.onDisk ? "bg-node-stopped" : "bg-text-muted/40"
        }`} />
        <span className="text-sm font-medium text-text mr-1">{seed.name}</span>
        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded ${
          seed.onDisk ? "bg-node-active/10 text-node-active" : "bg-accent/15 text-accent"
        }`}>
          {seed.onDisk ? "installed" : "marketplace"}
        </span>
        {isPersonal && (
          <span
            className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-400"
            title="Saved by you from the running network — deletable from this dashboard."
          >
            personal
          </span>
        )}
        {seed.local?.store && (
          <span
            className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-accent/15 text-accent font-mono"
            title={`Ships with the ${seed.local.store} store`}
          >
            {seed.local.store}
          </span>
        )}
        {seed.tags.map((t) => (
          <span key={t} className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">{t}</span>
        ))}
        <div className="basis-full sm:basis-auto sm:ml-auto flex flex-wrap items-center gap-2 mt-1 sm:mt-0">
          {seed.onDisk ? (
            <>
              <button
                onClick={() => onApply(true)}
                disabled={!canApply || applying}
                title={applyTitle ?? "Spawn this seed's nodes alongside the running network — names that already exist are skipped."}
                className="px-2 py-1 text-xs rounded text-text-muted hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add only
              </button>
              <button
                onClick={() => onApply(false)}
                disabled={!canApply || applying}
                title={applyTitle ?? "Replace the running network with this seed's nodes (DB tables survive)."}
                className={`px-3 py-1 text-xs rounded ${
                  canApply ? "bg-accent text-accent-fg hover:bg-accent/90" : "bg-surface-overlay text-text-muted cursor-not-allowed"
                } disabled:opacity-50`}
              >
                {applying ? "Applying…" : "Apply (replace)"}
              </button>
              {isPersonal && (
                <button
                  onClick={onDelete}
                  disabled={deleting}
                  title="Delete this personal seed from disk."
                  className="px-2 py-1 text-xs rounded text-node-stopped hover:bg-node-stopped/10 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              )}
            </>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing}
              className="px-3 py-1 text-xs rounded bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50"
            >
              {installing ? "Pulling…" : "Pull from marketplace"}
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-text-muted">{seed.description}</p>

      {/* Real nodes list (with names) — preferred over `needs[]`. Falls back
          to needs only when we don't have the parsed seed contents. */}
      <SeedNodes seed={seed} />

      {seed.market && (
        <div className="mt-1 text-[10px] text-text-muted font-mono">
          {seed.market.repo}@{seed.market.ref.slice(0, 8)}
        </div>
      )}
    </div>
  );
}

function SeedNodes({ seed }: { seed: UnifiedSeed }): React.ReactElement | null {
  // Local seeds carry the parsed nodes[] from the YAML; marketplace
  // seeds may carry a `nodes` summary in the registry. Pick the
  // richer source — only fall back to needs[] when neither is
  // available, with a hint that what's shown is just the dependency
  // declaration, not the actual spawn list.
  const realNodes = seed.local?.nodes ?? seed.market?.nodes ?? [];
  const missing = new Set(seed.local?.missing_types ?? []);
  const sources = seed.local?.type_sources ?? {};

  if (realNodes.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1 mt-1.5 text-[11px]">
        <span className="text-text-muted">spawns:</span>
        {realNodes.map((n) => {
          const isMissing = missing.has(n.type);
          const fromStore = sources[n.type];
          const title = isMissing
            ? fromStore
              ? `type: ${n.type} — missing (ships with ${fromStore} — install it to enable this seed)`
              : `type: ${n.type} — missing (source store unknown locally)`
            : fromStore
              ? `type: ${n.type} — part of ${fromStore}`
              : `type: ${n.type}`;
          return (
            <span
              key={`${n.name}-${n.type}`}
              className={`px-1.5 py-0.5 rounded ${
                isMissing
                  ? "bg-node-stopped/15 text-node-stopped ring-1 ring-node-stopped/30"
                  : "bg-surface-overlay text-text"
              }`}
              title={title}
            >
              <span className="font-medium">{n.name}</span>
              <span className={isMissing ? "text-node-stopped/80" : "text-text-muted"}> · {n.type}</span>
            </span>
          );
        })}
      </div>
    );
  }
  if (seed.needs && seed.needs.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1 mt-1.5 text-[11px]">
        <span className="text-text-muted" title="Dependency declaration — actual node list unavailable until installed.">
          requires:
        </span>
        {seed.needs.map((n) => (
          <code key={n} className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">{n}</code>
        ))}
      </div>
    );
  }
  return null;
}
