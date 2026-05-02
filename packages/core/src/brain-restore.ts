import { type NodeInfo, type NodeInstanceConfig, type NodeModule, type RunMode, NodeState } from "@brain/sdk";
import type Database from "better-sqlite3";
import { loadAllNodes, loadSubscriptions } from "./db";
import { logger } from "./logger";
import { createRunner, type BaseRunner, type SleepService } from "./runner";
import type { IBusService } from "./bus";
import type { TypeRegistry, InstanceRegistry } from "./registry";

type HandlerLoader = (typeName: string, typePath: string) => Promise<NodeModule>;

export async function restoreNodes(opts: {
  db: Database.Database;
  bus: IBusService;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  sleepService: SleepService;
  runners: Map<string, BaseRunner>;
  globalRunMode: RunMode;
  loadHandler: HandlerLoader;
  spawnNode?: (config: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killNode?: (id: string, caller?: string, reason?: string) => boolean;
}): Promise<number> {
  const savedNodes = loadAllNodes(opts.db);
  let restored = 0;

  for (const saved of savedNodes) {
    const subs = loadSubscriptions(opts.db, saved.id);

    if (!opts.typeRegistry.has(saved.type)) {
      logger.warn({ type: saved.type, name: saved.name }, "Skipping restore: type not registered");
      continue;
    }

    const typePath = opts.typeRegistry.getPath(saved.type);
    if (!typePath) continue;

    const typeConfig = opts.typeRegistry.get(saved.type);

    const isWeb = saved.transport === "web";
    let mod: NodeModule;
    if (isWeb) {
      // Web nodes have no JS module to load — the WebRunner is the
      // sole executor. Provide a no-op handler that satisfies the
      // runner factory's type contract.
      mod = { handler: (): Promise<void> => Promise.resolve() };
    } else {
      try {
        mod = await opts.loadHandler(saved.type, typePath);
      } catch {
        logger.warn({ type: saved.type, name: saved.name }, "Skipping restore: handler load failed");
        continue;
      }
    }

    const tags = JSON.parse(saved.tags) as string[];
    const subscriptions = subs.map((s) => ({
      topic: s.topic,
      min_criticality: s.min_criticality ?? undefined,
      mailbox: {
        max_size: s.mailbox_max_size,
        retention: s.mailbox_retention as "latest" | "lowest_priority",
      },
    }));

    const nodeInfo: NodeInfo = {
      id: saved.id,
      type: saved.type,
      name: saved.name,
      description: saved.description || typeConfig?.description || saved.type,
      tags,
      authority_level: saved.authority_level,
      state: NodeState.ACTIVE,
      priority: saved.priority,
      subscriptions,
      transport: saved.transport as "process" | "container" | "web",
      position: { x: saved.position_x, y: saved.position_y },
      config_overrides: JSON.parse(saved.config_overrides) as Record<string, unknown>,
      default_publishes: typeConfig?.default_publishes,
      created_at: saved.created_at,
    };

    opts.instanceRegistry.add(nodeInfo);

    for (const sub of subscriptions) {
      opts.bus.subscribe(nodeInfo.id, sub.topic, {
        min_criticality: sub.min_criticality,
        mailbox: sub.mailbox,
      });
    }

    const runner = createRunner(
      nodeInfo,
      mod.handler,
      {
        bus: opts.bus, registry: opts.instanceRegistry, sleepService: opts.sleepService,
        spawnNode: opts.spawnNode,
        killNode: opts.killNode,
      },
      opts.globalRunMode,
      mod.teardown,
      mod.onSpawn,
    );
    opts.runners.set(nodeInfo.id, runner);

    runner.start();

    restored++;
  }

  if (restored > 0) {
    logger.info({ count: restored }, "Restored nodes from database");
  }

  return restored;
}
