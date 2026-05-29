/**
 * Shared marketplace data — fetched ONCE when the Marketplace tab
 * first opens, then cached in module-level state so flipping
 * between Seeds / Libraries sub-tabs doesn't refetch and the user
 * gets an instant view.
 *
 * Refresh paths:
 *   - `refetch()`        — re-read /store/* from disk + cache (cheap, no git)
 *   - `pullMarketplace()` — `git pull` the local store, then refetch
 *
 * The "marketplace update available" badge reads the last-known
 * origin/main ref on disk, which is updated by `git pull` (and by
 * any background `git fetch` the user runs from the CLI). We don't
 * auto-fetch on tab open — that's what made the panel slow.
 */
import { useEffect, useState, useCallback } from "react";
import {
  getStoreNodes, getStoreCandidates, getInstalledUpdates,
  getStoreUpstreamStatus, refreshStore,
  type StoreNodeStatus, type StoreCandidate, type InstalledNodeUpdate,
} from "../api/store";
import { getSeeds, type SeedInfo } from "../api/client";

interface MarketplaceCache {
  nodes: StoreNodeStatus[];
  candidates: StoreCandidate[];
  updates: Map<string, InstalledNodeUpdate>;
  upstreamAhead: boolean;
  localSeeds: SeedInfo[];
  repoDescriptions: Map<string, string>;
  fetchedAt: number;
}

type Listener = (snapshot: MarketplaceCache | null) => void;

let cache: MarketplaceCache | null = null;
let inflight: Promise<MarketplaceCache> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l(cache);
}

async function fetchAll(): Promise<MarketplaceCache> {
  const [n, c, u, ups, ls, idx] = await Promise.all([
    getStoreNodes().catch(() => [] as StoreNodeStatus[]),
    getStoreCandidates().catch(() => [] as StoreCandidate[]),
    getInstalledUpdates().catch(() => [] as InstalledNodeUpdate[]),
    getStoreUpstreamStatus().catch(() => ({ updateAvailable: false, localSha: null, remoteSha: null })),
    getSeeds().catch(() => [] as SeedInfo[]),
    fetch("/store/index").then((r) => r.json() as Promise<{ repos: Record<string, { description?: string }> }>)
      .catch(() => ({ repos: {} })),
  ]);
  const fresh: MarketplaceCache = {
    nodes: n, candidates: c,
    updates: new Map(u.map((x) => [x.repo, x])),
    upstreamAhead: ups.updateAvailable,
    localSeeds: ls,
    repoDescriptions: new Map(Object.entries(idx.repos).map(([k, v]) => [k, v.description ?? ""])),
    fetchedAt: Date.now(),
  };
  return fresh;
}

async function ensureLoaded(force = false): Promise<MarketplaceCache> {
  if (!force && cache) return cache;
  if (inflight) return inflight;
  inflight = fetchAll().then((v) => { cache = v; notify(); return v; })
    .finally(() => { inflight = null; });
  return inflight;
}

export interface UseMarketplace {
  data: MarketplaceCache | null;
  loading: boolean;
  refetch: () => Promise<void>;
  pullMarketplace: () => Promise<{ updated: boolean; message: string }>;
}

export function useMarketplace(): UseMarketplace {
  const [data, setData] = useState<MarketplaceCache | null>(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    const listener: Listener = (snap) => setData(snap);
    listeners.add(listener);
    if (!cache) {
      setLoading(true);
      void ensureLoaded().finally(() => setLoading(false));
    }
    return () => { listeners.delete(listener); };
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try { await ensureLoaded(true); } finally { setLoading(false); }
  }, []);

  const pullMarketplace = useCallback(async (): Promise<{ updated: boolean; message: string }> => {
    const r = await refreshStore();
    await ensureLoaded(true);
    return r;
  }, []);

  return { data, loading, refetch, pullMarketplace };
}
