import type { HubRef } from "./types";

/**
 * Resolve which of a peer hub's candidate HTTP bases this client can
 * actually reach. A hub advertises every interface it has (`http_urls`)
 * because it can't know which one a given peer routes to — a LAN IP, or a
 * VPN/WSL/Docker adapter that's unreachable from here. We probe them in
 * order (the hub already ranks LAN-first) and keep the first that answers,
 * cached per hub so we only pay the probe once. Like picking an ICE
 * candidate.
 */
const cache = new Map<string, string>();

async function probe(base: string, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/network/transport`, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * First reachable HTTP base for `hub`, or its best-guess `http_url` if no
 * candidate answers (better to try than nothing). Undefined when the hub
 * advertised no HTTP base at all.
 */
export async function reachableHubBase(hub: HubRef): Promise<string | undefined> {
  const hit = cache.get(hub.hub_id);
  if (hit) return hit;

  const candidates = hub.http_urls?.length
    ? hub.http_urls
    : hub.http_url
      ? [hub.http_url]
      : [];
  if (candidates.length === 0) return undefined;

  for (const base of candidates) {
    if (await probe(base, 1800)) {
      cache.set(hub.hub_id, base);
      return base;
    }
  }
  return candidates[0];
}

/** Forget a hub's cached base (e.g. it expired / reconnected on a new IP). */
export function forgetHubBase(hubId: string): void {
  cache.delete(hubId);
}
