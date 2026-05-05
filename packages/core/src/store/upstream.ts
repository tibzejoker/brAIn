/**
 * Upstream-status helpers for the local marketplace clone.
 *
 * Extracted from store.service.ts to keep the install / fetch
 * surface readable. Pure git-CLI shell-outs — the StoreService
 * delegates here when the dashboard asks "is there an update?"
 * or "did I just pull?".
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StoreRegistry } from "./store.service";

function rev(cwd: string, ref = "HEAD"): string | null {
  const r = spawnSync("git", ["rev-parse", ref], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? (r.stdout as Buffer).toString().trim() : null;
}

export interface RefreshResult { updated: boolean; message: string }

export function refreshLocalStore(localStoreDir: string): RefreshResult {
  if (!fs.existsSync(localStoreDir)) {
    return { updated: false, message: `local store missing at ${localStoreDir} — falling back to HTTP` };
  }
  const beforeSha = rev(localStoreDir) ?? "";
  // Same EOL-neutralising flags as install.ts cloneAndCheckout — a
  // user with `core.autocrlf=true` would otherwise rewrite the
  // marketplace's checked-in JSON/YAML on pull.
  const r = spawnSync("git", [
    "-c", "core.autocrlf=false", "-c", "core.eol=lf",
    "pull", "--ff-only",
  ], {
    cwd: localStoreDir, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  if (r.status !== 0) {
    const err = (r.stderr as Buffer | undefined)?.toString() ?? "";
    return { updated: false, message: `git pull failed: ${err.split("\n")[0]}` };
  }
  const afterSha = rev(localStoreDir) ?? "";
  if (beforeSha === afterSha) return { updated: false, message: `already up to date (${beforeSha.slice(0, 8)})` };
  return { updated: true, message: `${beforeSha.slice(0, 8)} → ${afterSha.slice(0, 8)}` };
}

export interface UpstreamStatus {
  updateAvailable: boolean;
  localSha: string | null;
  remoteSha: string | null;
}

/**
 * Cheap "marketplace ahead?" check — does NOT contact origin. Reads
 * the last-known `origin/main` ref on disk (set by the most recent
 * `git fetch` or `git pull`). The dashboard's "Pull marketplace"
 * button is what actually goes to the network; everything else is
 * read-only against local git state so opening the Marketplace tab
 * is instant.
 */
export function marketplaceHasUpdate(localStoreDir: string): UpstreamStatus {
  if (!fs.existsSync(localStoreDir)) {
    return { updateAvailable: false, localSha: null, remoteSha: null };
  }
  const localSha = rev(localStoreDir);
  const remoteSha = rev(localStoreDir, "origin/main");
  return { updateAvailable: !!localSha && !!remoteSha && localSha !== remoteSha, localSha, remoteSha };
}

export interface NodeUpdate {
  name: string;
  repo: string;
  localSha: string | null;
  pinnedSha: string;
  updateAvailable: boolean;
}

/**
 * For each installed sister repo (one per `repo` in the registry's
 * nodes list), compare local HEAD to the marketplace's pinned `ref`.
 * Returns one entry per repo, not per node.
 */
export function installedNodeUpdates(reg: StoreRegistry, siblingsRoot: string): NodeUpdate[] {
  const seen = new Set<string>();
  const out: NodeUpdate[] = [];
  for (const n of reg.nodes) {
    if (seen.has(n.repo)) continue;
    seen.add(n.repo);
    const repoDir = path.resolve(siblingsRoot, n.repo);
    if (!fs.existsSync(repoDir)) continue;
    if (!n.ref) continue;
    const localSha = rev(repoDir);
    out.push({
      name: n.repo, repo: n.repo, localSha, pinnedSha: n.ref,
      updateAvailable: !!localSha && localSha !== n.ref,
    });
  }
  return out;
}
