import { useCallback, useEffect, useState } from "react";
import {
  getStoreNodes, installFromStore, getStoreCandidates,
  refreshStore, getStoreUpstreamStatus, getInstalledUpdates,
  type StoreNodeStatus, type StoreCandidate, type InstalledNodeUpdate,
} from "../api/client";

/**
 * Store panel — lists nodes from the curated `brAIn-store` registry,
 * shows installation status, and lets the user install missing nodes
 * with one click. Installation clones the parent repo as a sibling of
 * the brAIn checkout; the framework rescans its type registry on the
 * round-trip.
 */
export function StorePanel({ onInstalled }: { onInstalled: () => void }): React.ReactElement {
  const [nodes, setNodes] = useState<StoreNodeStatus[]>([]);
  const [candidates, setCandidates] = useState<StoreCandidate[]>([]);
  const [installedUpdates, setInstalledUpdates] = useState<Map<string, InstalledNodeUpdate>>(new Map());
  const [marketplaceAhead, setMarketplaceAhead] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    void Promise.all([
      getStoreNodes().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setBanner({ type: "error", message: `store unreachable — ${msg}` });
        return [] as StoreNodeStatus[];
      }),
      getStoreCandidates().catch(() => [] as StoreCandidate[]),
      getInstalledUpdates().catch(() => [] as InstalledNodeUpdate[]),
      getStoreUpstreamStatus().catch(() => ({ updateAvailable: false, localSha: null, remoteSha: null })),
    ])
      .then(([n, c, u, ups]) => {
        setNodes(n); setCandidates(c);
        setInstalledUpdates(new Map(u.map((x) => [x.repo, x])));
        setMarketplaceAhead(ups.updateAvailable);
      })
      .finally(() => setLoading(false));
  }, []);

  const pullMarketplace = useCallback((): void => {
    setPulling(true);
    refreshStore()
      .then((r) => {
        setBanner({ type: r.updated ? "success" : "info", message: `marketplace: ${r.message}` });
        refresh();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setBanner({ type: "error", message: `pull failed — ${msg}` });
      })
      .finally(() => setPulling(false));
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleInstall = useCallback((pkg: string): void => {
    setInstalling(pkg);
    setBanner(null);
    installFromStore(pkg)
      .then((res) => {
        const tone = res.status === "installed" ? "success" : "info";
        setBanner({ type: tone, message: `${res.status}: ${res.message}` });
        onInstalled();
        refresh();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setBanner({ type: "error", message: msg });
      })
      .finally(() => setInstalling(null));
  }, [onInstalled, refresh]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Store</h2>
        <span className="text-xs text-text-muted">{nodes.length} node(s) listed</span>
        {marketplaceAhead && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-accent/20 text-accent font-semibold">
            marketplace update available
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={pullMarketplace}
            disabled={pulling}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              marketplaceAhead
                ? "bg-accent/20 text-accent hover:bg-accent/30"
                : "text-text-muted hover:text-text"
            }`}
            title="git pull the local brAIn-store clone"
          >
            {pulling ? "pulling…" : marketplaceAhead ? "Pull update" : "Pull marketplace"}
          </button>
          <button
            onClick={refresh}
            className="text-xs text-text-muted hover:text-text transition-colors"
          >
            Refresh view
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`px-5 py-2 text-xs ${
            banner.type === "success" ? "bg-node-active/10 text-node-active"
            : banner.type === "error" ? "bg-node-stopped/10 text-node-stopped"
            : "bg-surface-overlay text-text-muted"
          }`}
        >
          {banner.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="text-text-muted text-xs py-8 text-center">Loading registry…</div>
        )}

        {candidates.length > 0 && (
          <div className="border-b border-border bg-accent/5">
            <div className="px-5 py-2 text-[11px] uppercase tracking-wide text-accent font-semibold">
              Local candidates · {candidates.length}
              <span className="ml-2 normal-case text-text-muted font-normal">
                authored locally — copy <code>registry_entry</code> into a PR against
                <code className="ml-1">brAIn-store/registry.json</code> to share.
              </span>
            </div>
            {candidates.map((c) => (
              <div key={c.type_name} className="px-5 py-3 border-t border-border/40">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full bg-accent" />
                  <span className="text-sm font-medium text-text">{c.type_name}</span>
                  <span className="text-xs text-text-muted font-mono">{c.package_name}</span>
                  {c.has_ui && (
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">ui</span>
                  )}
                  <button
                    onClick={() => {
                      const json = JSON.stringify(c.registry_entry, null, 2);
                      void navigator.clipboard.writeText(json);
                      setBanner({ type: "success", message: `${c.type_name} entry copied to clipboard` });
                    }}
                    className="ml-auto px-2 py-1 text-[11px] rounded bg-accent/20 text-accent hover:bg-accent/30"
                  >
                    Copy registry entry
                  </button>
                </div>
                <p className="text-xs text-text-muted mb-1">{c.description}</p>
                <p className="text-[11px] text-text-muted font-mono truncate">{c.workspace}</p>
              </div>
            ))}
          </div>
        )}

        {nodes.map((n) => (
          <div
            key={n.package_name}
            className="px-5 py-4 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${n.installed ? "bg-node-active" : "bg-text-muted/40"}`} />
              <span className="text-sm font-medium text-text">{n.name}</span>
              <span className="text-xs text-text-muted font-mono">{n.package_name}</span>
              <span className="text-xs text-text-muted">v{n.version}</span>

              <div className="ml-auto flex items-center gap-2">
                {n.needs_python && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">py</span>
                )}
                {n.needs_ollama && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">ollama</span>
                )}
                {n.has_ui && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">ui</span>
                )}
                {n.installed ? (
                  ((): React.ReactElement => {
                    const upd = installedUpdates.get(n.repo);
                    if (upd?.updateAvailable) {
                      return (
                        <button
                          disabled={installing !== null}
                          onClick={() => handleInstall(n.package_name)}
                          className="px-3 py-1 text-xs rounded bg-accent/20 text-accent font-semibold hover:bg-accent/30 disabled:opacity-40"
                          title={`local ${(upd.localSha ?? "?").slice(0, 8)} → pinned ${n.version} @ ${upd.pinnedSha.slice(0, 8)}`}
                        >
                          {installing === n.package_name ? "updating…" : "Update available"}
                        </button>
                      );
                    }
                    return <span className="text-xs text-node-active">installed</span>;
                  })()
                ) : (
                  <button
                    disabled={installing !== null}
                    onClick={() => handleInstall(n.package_name)}
                    className="px-3 py-1 text-xs rounded bg-node-active text-bg font-semibold disabled:opacity-40 hover:bg-node-active/80"
                  >
                    {installing === n.package_name ? "installing…" : "Install"}
                  </button>
                )}
              </div>
            </div>

            <p className="text-xs text-text-muted mb-2">{n.description}</p>

            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-text-muted">from</span>
              <code className="text-text-muted">{n.repo}/{n.subpath}</code>
              {n.tags?.map((tag) => (
                <span key={tag} className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">
                  {tag}
                </span>
              ))}
            </div>

            {n.installed && n.install_path && (
              <p className="mt-1 text-[11px] text-text-muted font-mono">
                {n.install_path}
              </p>
            )}
          </div>
        ))}

        {!loading && nodes.length === 0 && !banner && (
          <div className="text-text-muted text-xs py-8 text-center">
            Empty registry. Set <code>BRAIN_STORE_URL</code> to point at a custom one.
          </div>
        )}
      </div>
    </div>
  );
}
