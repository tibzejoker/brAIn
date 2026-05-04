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
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger";
import type { TypeRegistry } from "../registry";
import {
  type NodeUpdate, type RefreshResult, type UpstreamStatus,
  installedNodeUpdates, marketplaceHasUpdate, refreshLocalStore,
} from "./upstream";
import { type InstallSeedResult, installSeedYaml } from "./seeds";
import { cloneAndCheckout, installAndBuild, verifyChecksums } from "./install";

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
  /**
   * Pinned commit SHA (or tag / branch). When the registry ships a
   * full 40-char SHA, the installer enforces an exact post-checkout
   * match — any drift in the upstream repo (force-push, hijack, etc.)
   * aborts the install. Tags / branch names get the same treatment
   * but are obviously mutable upstream; SHAs are the recommended form.
   */
  ref?: string;
  tags?: string[];
  description: string;
  has_ui?: boolean;
  needs_python?: boolean;
  needs_ollama?: boolean;
  /**
   * Optional per-file SHA-256 manifest for the node's `subpath`.
   * Keys are paths relative to subpath; values are lowercase
   * hex digests. When present, the installer hashes every listed
   * file post-checkout and aborts on any mismatch — this is the
   * second supply-chain seatbelt on top of `ref` pinning.
   */
  checksums?: Record<string, string>;
}

export interface StoreSeed {
  name: string;
  description: string;
  /** Repo from `repos` whose subpath holds the YAML. */
  repo: string;
  subpath: string;
  /** Pinned commit SHA of the seed file. Required. */
  ref: string;
  /** SHA-256 of the seed YAML — verified before writing locally. */
  checksum: string;
  tags?: string[];
  /** Hint for dashboard filtering — types the seed asks for in its needs[]. */
  needs?: string[];
}

export interface StoreRegistry {
  version: number;
  updated_at?: string;
  repos: Record<string, StoreRepo>;
  nodes: StoreNode[];
  /** Optional — older registries may omit this. */
  seeds?: StoreSeed[];
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

/**
 * Locally-built node type that's a candidate for being published to the
 * public store. These come from the developer node's auto-author flow
 * (origin=dynamic): the framework already registered them so they can
 * be spawned, but they live in `nodes/_dynamic/` and aren't in any
 * published repo yet — the user has to copy them out + open a PR
 * against `brAIn-store/registry.json` to share them.
 */
export interface StoreCandidate {
  type_name: string;
  /** Suggested package name for the registry — `@brain/node-<name>`. */
  package_name: string;
  /** Local workspace path where the built artifacts live. */
  workspace: string;
  description: string;
  tags: string[];
  has_ui: boolean;
  /** Whoever authored it (developer node id, brain id, etc.). */
  created_by?: string;
  /** ISO date string when the type was first registered. */
  created_at?: string;
  /** A registry entry the user can paste into brAIn-store/registry.json. */
  registry_entry: Pick<StoreNode, "name" | "package_name" | "version" | "tags" | "description" | "has_ui">;
}

export class StoreService {
  private cache: { fetched_at: number; data: StoreRegistry } | null = null;
  private readonly frameworkRoot: string;

  constructor(
    private readonly typeRegistry: TypeRegistry,
    /** Where to clone parent repos. Conventionally the brAIn workspace's parent. */
    private readonly siblingsRoot: string,
    private readonly storeUrl: string = process.env.BRAIN_STORE_URL ?? DEFAULT_STORE_URL,
    /**
     * Root of the framework repo itself — used as the cwd for the
     * post-clone `pnpm install`, so workspace:* refs in the freshly
     * cloned sister repo resolve through brAIn's pnpm-workspace.yaml
     * (which lists `../brAIn-<X>/nodes/*` siblings). Defaults to
     * `<siblingsRoot>/brAIn` per convention.
     */
    frameworkRoot?: string,
  ) {
    this.frameworkRoot = frameworkRoot ?? path.resolve(siblingsRoot, "brAIn");
  }

  /**
   * Path to the locally-cloned `brAIn-store` repo, by convention a
   * sibling of brAIn. Cloned automatically by the framework's
   * postinstall (scripts/clone-store.mjs) so the registry is
   * available offline.
   */
  private get localStoreDir(): string {
    return path.resolve(this.siblingsRoot, "brAIn-store");
  }

  /**
   * Fetch the registry. Source of truth (in order):
   *   1. local clone at `<siblings>/brAIn-store/registry.json` — works
   *      offline, edits via `git pull` (see `refreshLocalStore`)
   *   2. HTTP fallback to `BRAIN_STORE_URL` — when the clone is
   *      missing (network-disabled install, custom registry, …)
   * 60-second in-memory cache on top of either source.
   */
  async fetchRegistry(force = false): Promise<StoreRegistry> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.fetched_at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    const localPath = path.join(this.localStoreDir, "registry.json");
    let data: StoreRegistry;
    if (fs.existsSync(localPath)) {
      try {
        data = JSON.parse(fs.readFileSync(localPath, "utf-8")) as StoreRegistry;
      } catch (err) {
        logger.warn({ err, localPath }, "store: local registry unreadable, falling back to HTTP");
        data = await this.httpFetch();
      }
    } else {
      data = await this.httpFetch();
    }
    if (data.version !== 1) throw new Error(`store: unsupported registry version ${data.version}`);
    this.cache = { fetched_at: now, data };
    return data;
  }

  private async httpFetch(): Promise<StoreRegistry> {
    const res = await fetch(this.storeUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`store: GET ${this.storeUrl} → HTTP ${res.status}`);
    return (await res.json()) as StoreRegistry;
  }

  /** Pull the local store + bust cache. Implementation in ./upstream.ts. */
  refreshLocalStore(): RefreshResult {
    const r = refreshLocalStore(this.localStoreDir);
    if (r.updated) this.cache = null;
    return r;
  }

  /** "Marketplace ahead?" without pulling. Implementation in ./upstream.ts. */
  marketplaceHasUpdate(): UpstreamStatus {
    return marketplaceHasUpdate(this.localStoreDir);
  }

  /** Per-repo "is local HEAD behind the registry's pinned ref?". */
  async installedNodeUpdates(): Promise<NodeUpdate[]> {
    const reg = await this.fetchRegistry();
    return installedNodeUpdates(reg, this.siblingsRoot);
  }

  /** All marketplace seeds with installed-locally status. */
  async listSeeds(seedsDir: string): Promise<Array<StoreSeed & { installed: boolean }>> {
    const reg = await this.fetchRegistry();
    return (reg.seeds ?? []).map((s) => ({
      ...s,
      installed: fs.existsSync(path.join(seedsDir, `${s.name}.yaml`)),
    }));
  }

  /** Install a marketplace seed (YAML pulled + checksum-verified). */
  async installSeed(name: string, seedsDir: string): Promise<InstallSeedResult> {
    const reg = await this.fetchRegistry(true);
    return installSeedYaml(reg, name, seedsDir);
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
    const cloneCheckout = cloneAndCheckout(repoMeta.clone, repoDir, ref);
    if (cloneCheckout.error) {
      // Roll back partial clones so a retry starts clean.
      if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
      return {
        status: "failed", message: cloneCheckout.error, cloned_to: null, re_scanned_types: 0,
      };
    }
    if (node.checksums) {
      const mismatch = verifyChecksums(path.join(repoDir, node.subpath), node.checksums);
      if (mismatch) {
        fs.rmSync(repoDir, { recursive: true, force: true });
        return {
          status: "failed",
          message: `checksum mismatch in ${node.subpath}: ${mismatch}`,
          cloned_to: null, re_scanned_types: 0,
        };
      }
    }
    // Sister repos do not commit dist/. Build them in-place so the
    // type registry can find dist/handler.js when spawning. Skip if
    // the dist already exists (e.g. user pre-built before install).
    if (!fs.existsSync(path.join(repoDir, node.subpath, "dist", "handler.js"))) {
      const buildErr = installAndBuild(repoDir, this.frameworkRoot);
      if (buildErr) {
        fs.rmSync(repoDir, { recursive: true, force: true });
        return {
          status: "failed",
          message: `post-install build failed: ${buildErr}`,
          cloned_to: null, re_scanned_types: 0,
        };
      }
    }
    const scanned = this.rescan(repoDir);
    return {
      status: "installed",
      message: `cloned ${node.repo}@${ref}${node.checksums ? " (checksums OK)" : ""} to ${repoDir}`,
      cloned_to: repoDir,
      re_scanned_types: scanned,
    };
  }

  /**
   * List dynamic node types currently registered locally — i.e. the
   * developer-authored ones — and turn them into store-candidate
   * manifests. The user can then copy `registry_entry` into a PR
   * against the public store. Skips workspaces that haven't built yet
   * (no `dist/handler.js`).
   */
  listCandidates(): StoreCandidate[] {
    const dyn = this.typeRegistry.list({ origin: "dynamic" });
    return dyn.flatMap((cfg) => {
      const workspace = this.typeRegistry.getPath(cfg.name);
      if (!workspace) return [];
      const built = fs.existsSync(path.join(workspace, "dist", "handler.js"));
      if (!built) return [];
      const packageName = `@brain/node-${cfg.name}`;
      const candidate: StoreCandidate = {
        type_name: cfg.name,
        package_name: packageName,
        workspace,
        description: cfg.description,
        tags: cfg.tags,
        has_ui: Boolean(cfg.has_ui),
        created_by: cfg.created_by,
        created_at: cfg.created_at,
        registry_entry: {
          name: cfg.name,
          package_name: packageName,
          version: "0.1.0",
          tags: cfg.tags,
          description: cfg.description,
          has_ui: Boolean(cfg.has_ui),
        },
      };
      return [candidate];
    });
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
