import { useCallback, useMemo, useState } from "react";
import { installFromStore, type StoreNodeStatus, type InstalledNodeUpdate } from "../../api/store";
import { useMarketplace } from "../../hooks/useMarketplace";

interface RepoGroup {
  repo: string;
  description: string;
  nodes: StoreNodeStatus[];
  installedCount: number;
  totalCount: number;
  hasUpdate: boolean;
}

function groupByRepo(
  nodes: StoreNodeStatus[],
  updates: Map<string, InstalledNodeUpdate>,
  repoDescriptions: Map<string, string>,
): RepoGroup[] {
  const map = new Map<string, RepoGroup>();
  for (const n of nodes) {
    let g = map.get(n.repo);
    if (!g) {
      const u = updates.get(n.repo);
      g = {
        repo: n.repo,
        description: repoDescriptions.get(n.repo) ?? "",
        nodes: [], installedCount: 0, totalCount: 0,
        hasUpdate: u?.updateAvailable ?? false,
      };
      map.set(n.repo, g);
    }
    g.nodes.push(n);
    g.totalCount++;
    if (n.installed) g.installedCount++;
  }
  return [...map.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

export function LibrariesView({ onChanged }: { onChanged: () => void }): React.ReactElement {
  const { data, loading, refetch, pullMarketplace } = useMarketplace();
  const [installing, setInstalling] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  const handlePull = useCallback((): void => {
    setPulling(true);
    pullMarketplace()
      .then((r) => setBanner({
        type: r.updated ? "success" : "info",
        message: `marketplace: ${r.message}`,
      }))
      .catch((err: unknown) => setBanner({
        type: "error",
        message: `pull failed — ${err instanceof Error ? err.message : String(err)}`,
      }))
      .finally(() => setPulling(false));
  }, [pullMarketplace]);

  // One install/update call per repo. We only need ONE package_name
  // per repo because the backend clones the whole sister repo and
  // rescans every node inside it; iterating over `packageNames` would
  // just re-trigger the same git operations on the same dir.
  const installLib = useCallback((
    repo: string, packageNames: string[], opts?: { update?: boolean },
  ): void => {
    const target = packageNames[0];
    if (!target) return;
    setInstalling(repo); setBanner(null);
    installFromStore(target, opts)
      .then((res) => {
        setBanner({
          type: res.status === "installed" ? "success" : "info",
          message: `${repo}: ${res.message}`,
        });
        onChanged();
        void refetch();
      })
      .catch((err: unknown) => setBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => setInstalling(null));
  }, [onChanged, refetch]);

  const groups = useMemo(() => {
    if (!data) return [];
    return groupByRepo(data.nodes, data.updates, data.repoDescriptions);
  }, [data]);

  const filtered = useMemo(() => groups.filter((g) => {
    if (!query) return true;
    const q = query.toLowerCase();
    if (g.repo.toLowerCase().includes(q) || g.description.toLowerCase().includes(q)) return true;
    return g.nodes.some((n) =>
      n.name.toLowerCase().includes(q)
      || n.description.toLowerCase().includes(q)
      || n.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }), [groups, query]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-2 border-b border-border bg-surface-raised/50">
        <span className="text-xs text-text-muted shrink-0 whitespace-nowrap">
          {groups.length} libraries · {data?.nodes.length ?? 0} nodes
        </span>
        {data?.upstreamAhead && (
          <span className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-accent/20 text-accent font-semibold whitespace-nowrap">
            marketplace update available
          </span>
        )}
        <input
          type="text"
          placeholder="Search libraries, nodes, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="order-last sm:order-none basis-full sm:basis-auto sm:flex-1 sm:max-w-md sm:ml-auto px-2 py-1 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text"
        />
        <button
          onClick={handlePull}
          disabled={pulling}
          title="git pull the local marketplace clone (network call)"
          className={`shrink-0 whitespace-nowrap text-xs px-2 py-1 rounded ${
            data?.upstreamAhead ? "bg-accent/20 text-accent hover:bg-accent/30" : "text-text-muted hover:text-text"
          }`}
        >
          {pulling ? "pulling…" : data?.upstreamAhead ? "Pull update" : "Pull marketplace"}
        </button>
      </div>

      {banner && (
        <div className={`px-5 py-2 text-xs ${
          banner.type === "success" ? "bg-node-active/10 text-node-active"
          : banner.type === "error" ? "bg-node-stopped/10 text-node-stopped"
          : "bg-surface-overlay text-text-muted"
        }`}>{banner.message}</div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && !data && <div className="text-text-muted text-xs py-8 text-center">Loading registry…</div>}

        {data && data.candidates.length > 0 && (
          <div className="px-5 py-3 border-b border-border bg-accent/5 text-[11px] text-accent">
            <strong>{data.candidates.length} local candidate(s)</strong> ready to publish to the marketplace.
          </div>
        )}

        {filtered.map((g) => (
          <LibCard
            key={g.repo}
            group={g}
            installing={installing === g.repo}
            onInstall={() => installLib(g.repo, g.nodes.filter((n) => !n.installed).map((n) => n.package_name))}
            onUpdate={() => installLib(g.repo, g.nodes.map((n) => n.package_name), { update: true })}
          />
        ))}

        {!loading && data && filtered.length === 0 && (
          <div className="text-text-muted text-xs py-8 text-center">
            {query ? `No libraries match "${query}"` : "Empty registry."}
          </div>
        )}
      </div>
    </>
  );
}

function LibCard({ group, installing, onInstall, onUpdate }: {
  group: RepoGroup; installing: boolean; onInstall: () => void; onUpdate: () => void;
}): React.ReactElement {
  const allInstalled = group.installedCount === group.totalCount;
  const someInstalled = group.installedCount > 0 && !allInstalled;
  return (
    <div className="px-4 sm:px-5 py-4 border-b border-border/50">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span className={`shrink-0 w-2 h-2 rounded-full ${
          allInstalled ? "bg-node-active" : someInstalled ? "bg-node-sleeping" : "bg-text-muted/40"
        }`} />
        <span className="text-sm font-medium text-text mr-1">{group.repo}</span>
        <span className="text-xs text-text-muted shrink-0">
          {group.installedCount}/{group.totalCount} nodes installed
        </span>
        {group.hasUpdate && (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent font-semibold">
            update available
          </span>
        )}
        <div className="basis-full sm:basis-auto sm:ml-auto flex flex-wrap items-center gap-2 mt-1 sm:mt-0">
          {!allInstalled && (
            <button
              onClick={onInstall}
              disabled={installing}
              className="px-3 py-1 text-xs rounded bg-node-active text-accent-fg font-semibold disabled:opacity-40 hover:bg-node-active/80"
            >
              {installing ? "installing…" : someInstalled ? "Install missing" : "Install lib"}
            </button>
          )}
          {allInstalled && group.hasUpdate && (
            <button
              onClick={onUpdate}
              disabled={installing}
              className="px-3 py-1 text-xs rounded bg-accent/20 text-accent font-semibold disabled:opacity-40 hover:bg-accent/30"
            >
              {installing ? "updating…" : "Update"}
            </button>
          )}
          {allInstalled && !group.hasUpdate && (
            <span className="text-xs text-node-active">installed</span>
          )}
        </div>
      </div>
      {group.description && <p className="text-xs text-text-muted mb-2">{group.description}</p>}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {group.nodes.map((n) => (
          <span
            key={n.package_name}
            title={n.description}
            className={`px-2 py-0.5 text-[11px] rounded font-mono ${
              n.installed ? "bg-node-active/10 text-node-active" : "bg-surface-overlay text-text-muted"
            }`}
          >
            {n.name}
          </span>
        ))}
      </div>
    </div>
  );
}
