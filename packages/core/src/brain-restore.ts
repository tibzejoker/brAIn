import { type NodeInfo, type NodeInstanceConfig, type NodeModule, type RunMode, type PortBindings, NodeState, normaliseSubscription } from "@brain/sdk";
import type Database from "better-sqlite3";
import { loadAllNodes, loadSubscriptions } from "./db";
import { logger } from "./logger";
import { createRunner, type BaseRunner } from "./runner";
import type { IBusService } from "./bus";
import type { TypeRegistry, InstanceRegistry } from "./registry";
import type { LLMRegistry } from "./llm/llm-registry";
import type { LLMConfigStore } from "./llm/llm-config";
import { mergePortBindings, autoDerivePorts, autoDeriveBindings } from "./ports";

type HandlerLoader = (typeName: string, typePath: string) => Promise<NodeModule>;

export async function restoreNodes(opts: {
  db: Database.Database;
  bus: IBusService;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  runners: Map<string, BaseRunner>;
  globalRunMode: RunMode;
  loadHandler: HandlerLoader;
  spawnNode?: (config: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killNode?: (id: string, caller?: string, reason?: string) => boolean;
  llmRegistry?: LLMRegistry;
  llmConfig?: LLMConfigStore;
  peerNodes?: () => NodeInfo[];
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
    // Fall back to the type's default_subscriptions for description /
    // inputSchema if the saved row was migrated from a pre-description
    // schema (legacy NULL/empty). This keeps old DB rows usable while
    // letting freshly-saved rows carry their own description.
    const typeDefaults = new Map(
      (typeConfig?.default_subscriptions ?? []).map((s) => [s.topic, s] as const),
    );
    // Dedupe DB rows by topic — pre-2-layer spawns left a bare row, the
    // port expansion later added a [port:…] one, so DB ends up with two
    // entries per topic. Prefer the row that carries a [port:…] description
    // (the port-derived one) since it has the right schema; fall back to
    // the most recent surviving row otherwise.
    const subByTopic = new Map<string, typeof subs[number]>();
    for (const s of subs) {
      const existing = subByTopic.get(s.topic);
      if (!existing) { subByTopic.set(s.topic, s); continue; }
      const isPort = s.description.startsWith("[port:");
      const existingIsPort = existing.description.startsWith("[port:");
      if (isPort && !existingIsPort) subByTopic.set(s.topic, s);
    }

    const subscriptions = Array.from(subByTopic.values()).map((s) => {
      const fallback = typeDefaults.get(s.topic);
      return normaliseSubscription({
        topic: s.topic,
        description: s.description || fallback?.description || s.topic,
        inputSchema: s.input_schema
          ? JSON.parse(s.input_schema) as Record<string, unknown>
          : fallback?.inputSchema,
        min_criticality: s.min_criticality ?? undefined,
        mailbox: {
          max_size: s.mailbox_max_size,
          retention: s.mailbox_retention as "latest" | "lowest_priority",
        },
        internal: fallback ? fallback.internal === true : false,
      });
    });

    // 2-layer wiring: bring the type's port declaration forward (it lives
    // in code, not in the DB) and merge any per-instance binding overrides
    // persisted in config_overrides._port_bindings on top of the type
    // defaults. Auto-derive when the type didn't migrate to ports yet so
    // unmigrated nodes still surface as ports in the dashboard.
    const cfgOverrides = JSON.parse(saved.config_overrides) as Record<string, unknown>;
    const overriddenBindings = cfgOverrides._port_bindings as PortBindings | undefined;
    const declaredPorts = typeConfig?.ports;
    const effectivePorts = declaredPorts
      ?? (typeConfig ? autoDerivePorts(typeConfig.default_subscriptions, typeConfig.default_publishes) : undefined);
    // `declaredPorts` is sourced from `typeConfig?.ports`, so when it is
    // truthy the typeConfig is guaranteed non-null; the `?.` would be
    // redundant. Branch explicitly to satisfy the linter.
    const baseBindings = typeConfig
      ? (declaredPorts
          ? typeConfig.default_port_bindings
          : autoDeriveBindings(typeConfig.default_subscriptions, typeConfig.default_publishes))
      : undefined;
    const effectiveBindings = mergePortBindings(baseBindings, overriddenBindings);

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
      config_overrides: cfgOverrides,
      default_publishes: typeConfig?.default_publishes,
      spawned_by: saved.spawned_by ?? undefined,
      created_at: saved.created_at,
      ports: effectivePorts,
      port_bindings: effectiveBindings,
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
        bus: opts.bus, registry: opts.instanceRegistry,
        spawnNode: opts.spawnNode,
        killNode: opts.killNode,
        llmRegistry: opts.llmRegistry,
        llmConfig: opts.llmConfig,
        peerNodes: opts.peerNodes,
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
