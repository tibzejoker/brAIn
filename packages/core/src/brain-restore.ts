import { type NodeInfo, type NodeInstanceConfig, type NodeModule, type RunMode, type PortBindings, NodeState, normaliseSubscription } from "@brain/sdk";
import type Database from "better-sqlite3";
import { loadAllNodes, loadSubscriptions } from "./db";
import { logger } from "./logger";
import { createRunner, type BaseRunner } from "./runner";
import type { IBusService } from "./bus";
import type { TypeRegistry, InstanceRegistry } from "./registry";
import type { LLMRegistry } from "./llm/llm-registry";
import type { LLMConfigStore } from "./llm/llm-config";
import { mergePortBindings, autoDerivePorts, autoDeriveBindings, expandPortsToSubs } from "./ports";

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

    const PERMISSIVE: Record<string, unknown> = { type: "object" };
    const dbSubs = Array.from(subByTopic.values()).map((s) => {
      const fallback = typeDefaults.get(s.topic);
      // Every input becomes a public sub with a schema. Subs declared
      // `internal:true` on legacy types fall back to a permissive
      // `{ type: "object" }` so the surface stays consistent (and any
      // node can in principle call them — that's the point).
      const schema = s.input_schema
        ? JSON.parse(s.input_schema) as Record<string, unknown>
        : (fallback?.inputSchema ?? PERMISSIVE);
      return normaliseSubscription({
        topic: s.topic,
        description: s.description || fallback?.description || s.topic,
        inputSchema: schema,
        min_criticality: s.min_criticality ?? undefined,
        mailbox: {
          max_size: s.mailbox_max_size,
          retention: s.mailbox_retention as "latest" | "lowest_priority",
        },
      });
    });

    // 2-layer wiring: bring the type's port declaration forward (it lives
    // in code, not in the DB) and merge any per-instance binding overrides
    // persisted in config_overrides._port_bindings on top of the type
    // defaults. Auto-derive when the type didn't migrate to ports yet so
    // unmigrated nodes still surface as ports in the dashboard.
    const cfgOverrides = JSON.parse(saved.config_overrides) as Record<string, unknown>;
    const overriddenBindings = cfgOverrides._port_bindings as PortBindings | undefined;
    // Merge: explicitly-declared ports OVERRIDE auto-derived ports from
    // default_subscriptions/publishes. Internal subs become inputSchema-
    // less internal ports; public subs become public ports. Bindings
    // similarly stack: auto-derived → declared defaults → instance overrides.
    const autoPorts = typeConfig ? autoDerivePorts(typeConfig.default_subscriptions, typeConfig.default_publishes) : undefined;
    const autoBindings = typeConfig ? autoDeriveBindings(typeConfig.default_subscriptions, typeConfig.default_publishes) : undefined;
    // Same dedupe as spawn: drop auto-derived ports/bindings whose topic
    // is already wired to an explicitly-declared port, otherwise the same
    // topic shows up under two ports.
    const declaredInTopics = new Set<string>();
    for (const ts of Object.values(typeConfig?.default_port_bindings?.inputs ?? {})) for (const t of ts) declaredInTopics.add(t);
    const declaredOutTopics = new Set<string>();
    for (const ts of Object.values(typeConfig?.default_port_bindings?.outputs ?? {})) for (const t of ts) declaredOutTopics.add(t);
    const filtAutoIn = Object.fromEntries(Object.entries(autoPorts?.inputs ?? {}).filter(([t]) => !declaredInTopics.has(t)));
    const filtAutoOut = Object.fromEntries(Object.entries(autoPorts?.outputs ?? {}).filter(([t]) => !declaredOutTopics.has(t)));
    const filtAutoBindingsIn = Object.fromEntries(Object.entries(autoBindings?.inputs ?? {}).filter(([t]) => !declaredInTopics.has(t)));
    const filtAutoBindingsOut = Object.fromEntries(Object.entries(autoBindings?.outputs ?? {}).filter(([t]) => !declaredOutTopics.has(t)));
    const effectivePorts = typeConfig
      ? {
          inputs: { ...filtAutoIn, ...(typeConfig.ports?.inputs ?? {}) },
          outputs: { ...filtAutoOut, ...(typeConfig.ports?.outputs ?? {}) },
        }
      : undefined;
    const declaredBindings = mergePortBindings({ inputs: filtAutoBindingsIn, outputs: filtAutoBindingsOut }, typeConfig?.default_port_bindings);
    const effectiveBindings = mergePortBindings(declaredBindings, overriddenBindings);

    // Expand the effective port bindings into subs and merge with the
    // DB-resident ones. DB subs that are also bound to a port get
    // replaced by the port-derived version (which carries [port:…] in
    // the description so the catalog can link them back). New ports
    // declared since the row was first saved get freshly added — that's
    // how `chat.reset` / `alerts.*` / `brain.*` come back to life on a
    // restore without rewriting the DB.
    const portSubs = expandPortsToSubs(effectivePorts, effectiveBindings);
    const portTopics = new Set(portSubs.map((s) => s.topic));
    const subscriptions = [...portSubs, ...dbSubs.filter((s) => !portTopics.has(s.topic))];

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
