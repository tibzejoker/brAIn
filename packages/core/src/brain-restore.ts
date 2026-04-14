import { type NodeInfo, type NodeHandler, type RunMode, NodeState } from "@brain/sdk";
import type Database from "better-sqlite3";
import { loadAllNodes, loadSubscriptions } from "./db";
import { logger } from "./logger";
import { createRunner, type BaseRunner, type SleepService } from "./runner";
import type { BusService } from "./bus";
import type { TypeRegistry, InstanceRegistry } from "./registry";

type HandlerLoader = (typeName: string, typePath: string) => Promise<NodeHandler>;

export async function restoreNodes(opts: {
  db: Database.Database;
  bus: BusService;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  sleepService: SleepService;
  runners: Map<string, BaseRunner>;
  globalRunMode: RunMode;
  loadHandler: HandlerLoader;
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

    let handler: NodeHandler;
    try {
      handler = await opts.loadHandler(saved.type, typePath);
    } catch {
      logger.warn({ type: saved.type, name: saved.name }, "Skipping restore: handler load failed");
      continue;
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
      transport: saved.transport as "process" | "container",
      position: { x: saved.position_x, y: saved.position_y },
      config_overrides: JSON.parse(saved.config_overrides) as Record<string, unknown>,
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
      handler,
      { bus: opts.bus, registry: opts.instanceRegistry, sleepService: opts.sleepService },
      opts.globalRunMode,
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
