/**
 * Seed orchestrator. Two phases:
 *
 *   1. needs[] — install missing types from the marketplace via
 *                StoreService (default package_name = `@brain/node-<type>`).
 *                Failure aborts the seed.
 *   2. nodes[] — kill the running network, then spawn the seed's nodes.
 *
 * The DB is **never** wiped — history, mcp-oauth tokens, agent
 * directory, etc. all survive. Only running node *instances* are
 * replaced. To wipe DB schema use /network/reset which calls
 * killAll() + resetDb() explicitly.
 *
 * Use `merge: true` to keep the existing network alongside the seed
 * (idempotent reseed — names that already exist are skipped). The
 * dashboard exposes both modes.
 */
import type Database from "better-sqlite3";
import type { NodeInfo, NodeInstanceConfig } from "@brain/sdk";
import { recordHistory } from "../db";
import { logger } from "../logger";
import type { TypeRegistry, InstanceRegistry } from "../registry";
import type { StoreService } from "../store";
import { loadSeedFile } from "./seed";

export interface SeedResult {
  spawned: number;
  skipped: number;
  killed: number;
  installed: string[];
}

export interface SeedDeps {
  db: Database.Database;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  store: StoreService;
  spawnNode: (config: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killAll: () => number;
}

export interface SeedOpts {
  /**
   * When true, leave the running network alone and only spawn names
   * that aren't already present (idempotent additive mode). Default
   * false: apply replaces the network.
   */
  merge?: boolean;
}

export async function applySeed(
  deps: SeedDeps,
  filePath: string,
  opts: SeedOpts = {},
): Promise<SeedResult> {
  const { needs, nodes } = loadSeedFile(filePath);
  const installed: string[] = [];

  // Phase 1 — ensure every needed type is registered.
  for (const need of needs) {
    if (deps.typeRegistry.has(need.type)) continue;
    const pkg = need.package_name ?? `@brain/node-${need.type}`;
    logger.info({ type: need.type, package: pkg }, "seed: installing missing type from store");
    const r = await deps.store.install(pkg);
    if (r.status === "failed") {
      throw new Error(`seed: failed to install ${pkg}: ${r.message}`);
    }
    if (!deps.typeRegistry.has(need.type)) {
      throw new Error(
        `seed: installed ${pkg} but type '${need.type}' still not registered `
        + "(check the package's config.json `name` field)",
      );
    }
    installed.push(need.type);
  }

  // Phase 2 — replace OR merge with the running network.
  let killed = 0;
  if (!opts.merge) {
    killed = deps.killAll();
    logger.info({ killed }, "seed: killed running nodes (apply replaces — pass merge=true to keep them)");
  }

  const existingNames = new Set(deps.instanceRegistry.list().map((n) => n.name));
  let spawned = 0;
  let skipped = 0;
  for (const config of nodes) {
    if (existingNames.has(config.name)) {
      // Only possible in merge mode now; in replace mode killed
      // would have cleared the registry first.
      logger.info({ name: config.name }, "seed: name already exists, skipping (merge mode)");
      skipped++;
      continue;
    }
    try {
      await deps.spawnNode(config);
      spawned++;
      existingNames.add(config.name);
    } catch (err) {
      // Strict: every node in the seed MUST spawn. A partial network
      // is worse than no network at all — the user has no way to
      // tell which nodes silently dropped. Surface the failure and
      // let the caller decide what to do (hit /network/reset, fix
      // the seed, etc).
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, node: config.name, type: config.type }, "seed: failed to spawn");
      throw new Error(
        `seed: failed to spawn '${config.name}' (type: ${config.type}): ${errMsg}. `
        + `Network is now in a partial state (${spawned}/${nodes.length} spawned, ${killed} killed). `
        + `Hit /network/reset to wipe and try again.`,
      );
    }
  }

  recordHistory(deps.db, {
    action: "network.seeded",
    details: { file: filePath, spawned, skipped, killed, installed, mode: opts.merge ? "merge" : "replace" },
  });
  return { spawned, skipped, killed, installed };
}
