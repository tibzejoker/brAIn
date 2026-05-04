/**
 * Non-destructive seed orchestrator. Two phases:
 *
 *   1. needs[] — install missing types from the marketplace via
 *                StoreService (default package_name = `@brain/node-<type>`).
 *                Failure aborts the seed.
 *   2. nodes[] — spawn each entry whose `name` doesn't already exist.
 *                Existing names are skipped with a log so a reseed is
 *                idempotent and never silently clobbers state.
 *
 * Lives next to the seed parser to keep all seed-related logic in one
 * folder; called from BrainService.seed.
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
  installed: string[];
}

export interface SeedDeps {
  db: Database.Database;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  store: StoreService;
  spawnNode: (config: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
}

export async function applySeed(deps: SeedDeps, filePath: string): Promise<SeedResult> {
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

  // Phase 2 — spawn idempotently. Names already in the network are
  // skipped, never overwritten; the user must call /network/reset
  // to wipe before reseeding from scratch.
  const existingNames = new Set(deps.instanceRegistry.list().map((n) => n.name));
  let spawned = 0;
  let skipped = 0;
  for (const config of nodes) {
    if (existingNames.has(config.name)) {
      logger.info({ name: config.name }, "seed: name already exists, skipping (use /network/reset to wipe)");
      skipped++;
      continue;
    }
    try {
      await deps.spawnNode(config);
      spawned++;
      existingNames.add(config.name);
    } catch (err) {
      logger.error({ err, node: config.name }, "seed: failed to spawn");
    }
  }

  recordHistory(deps.db, {
    action: "network.seeded",
    details: { file: filePath, spawned, skipped, installed },
  });
  return { spawned, skipped, installed };
}
