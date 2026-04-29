/**
 * Store service — fetches the public node registry and installs nodes
 * by cloning their parent repository as a sibling of the brAIn checkout.
 *
 * This is the v1 model: a node is identified in the registry by its
 * `repo + subpath` rather than as a standalone npm package. Installing a
 * node means cloning the parent repo if not already present, then
 * refreshing the type-registry. No npm publishing required.
 *
 * The registry URL defaults to the public raw GitHub URL but can be
 * overridden via `BRAIN_STORE_URL`. A 60s in-memory cache avoids
 * hammering GitHub on dashboard refreshes.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger";
import type { TypeRegistry } from "../registry";

const DEFAULT_STORE_URL =
  "https://raw.githubusercontent.com/tibzejoker/brAIn-store/main/registry.json";
const CACHE_TTL_MS = 60_000;

export interface StoreRepo {
  url: string;
  clone: string;
  default_branch?: string;
  description?: string;
}

export interface StoreNode {
  name: string;
  package_name: string;
  repo: string;
  subpath: string;
  version: string;
  ref?: string;
  tags?: string[];
  description: string;
  has_ui?: boolean;
  needs_python?: boolean;
  needs_ollama?: boolean;
}

export interface StoreRegistry {
  version: number;
  updated_at?: string;
  repos: Record<string, StoreRepo>;
  nodes: StoreNode[];
}

export interface StoreNodeStatus extends StoreNode {
  installed: boolean;
  install_path: string | null;
}

export interface StoreInstallResult {
  status: "installed" | "already_present" | "failed";
  message: string;
  cloned_to: string | null;
  re_scanned_types: number;
}

export class StoreService {
  private cache: { fetched_at: number; data: StoreRegistry } | null = null;

  constructor(
    private readonly typeRegistry: TypeRegistry,
    /** Where to clone parent repos. Conventionally the brAIn workspace's parent. */
    private readonly siblingsRoot: string,
    private readonly storeUrl: string = process.env.BRAIN_STORE_URL ?? DEFAULT_STORE_URL,
  ) {}

  /** Fetch the registry, with a 60-second cache. */
  async fetchRegistry(force = false): Promise<StoreRegistry> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.fetched_at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    const res = await fetch(this.storeUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`store: GET ${this.storeUrl} → HTTP ${res.status}`);
    const data = (await res.json()) as StoreRegistry;
    if (data.version !== 1) throw new Error(`store: unsupported registry version ${data.version}`);
    this.cache = { fetched_at: now, data };
    return data;
  }

  /** Registry decorated with installation status for the dashboard. */
  async listWithStatus(): Promise<StoreNodeStatus[]> {
    const registry = await this.fetchRegistry();
    return registry.nodes.map((n) => {
      // `n.repo` may not exist in registry.repos — registry is user-curated
      // so we treat the lookup as nullable defensively (TS index sig is
      // non-narrowing without noUncheckedIndexedAccess; the cast makes the
      // runtime check meaningful and silences the linter).
      const repoMeta = registry.repos[n.repo] as StoreRepo | undefined;
      const installPath = repoMeta
        ? path.join(this.siblingsRoot, n.repo, n.subpath)
        : null;
      const installed =
        installPath !== null
        && fs.existsSync(installPath)
        && fs.existsSync(path.join(installPath, "config.json"));
      return { ...n, installed, install_path: installed ? installPath : null };
    });
  }

  /** Clone the parent repo of a node (if absent), then re-scan the type registry. */
  async install(packageName: string): Promise<StoreInstallResult> {
    const registry = await this.fetchRegistry(true);
    const node = registry.nodes.find((n) => n.package_name === packageName);
    if (!node) {
      return { status: "failed", message: `unknown package: ${packageName}`, cloned_to: null, re_scanned_types: 0 };
    }
    const repoMeta = registry.repos[node.repo] as StoreRepo | undefined;
    if (!repoMeta) {
      return { status: "failed", message: `registry references missing repo: ${node.repo}`, cloned_to: null, re_scanned_types: 0 };
    }
    const repoDir = path.join(this.siblingsRoot, node.repo);
    if (fs.existsSync(repoDir)) {
      logger.info({ repoDir, packageName }, "store: repo already present, skipping clone");
      const scanned = this.rescan(repoDir);
      return {
        status: "already_present",
        message: `${node.repo} is already checked out at ${repoDir}`,
        cloned_to: repoDir,
        re_scanned_types: scanned,
      };
    }
    logger.info({ clone: repoMeta.clone, target: repoDir }, "store: cloning repo");
    const ref = node.ref ?? repoMeta.default_branch ?? "main";
    const r = spawnSync("git", ["clone", "--depth", "1", "--branch", ref, repoMeta.clone, repoDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      const stderrBuf = r.stderr as Buffer | undefined;
      return {
        status: "failed",
        message: `git clone failed (${r.status}): ${stderrBuf ? stderrBuf.toString() : ""}`,
        cloned_to: null,
        re_scanned_types: 0,
      };
    }
    const scanned = this.rescan(repoDir);
    return {
      status: "installed",
      message: `cloned ${node.repo} to ${repoDir}`,
      cloned_to: repoDir,
      re_scanned_types: scanned,
    };
  }

  /** Re-scan a freshly-installed repo's `nodes/` directory and register new types. */
  private rescan(repoDir: string): number {
    const nodesDir = path.join(repoDir, "nodes");
    if (!fs.existsSync(nodesDir)) return 0;
    const before = this.typeRegistry.list().length;
    this.typeRegistry.scanDirectory(nodesDir);
    const after = this.typeRegistry.list().length;
    return after - before;
  }
}
