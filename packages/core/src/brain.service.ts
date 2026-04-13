import {
  type NodeInfo,
  type NodeHandler,
  type NodeInstanceConfig,
  NodeState,
} from "@brain/sdk";
import type Database from "better-sqlite3";
import EventEmitter from "eventemitter3";
import { v4 as uuid } from "uuid";
import { BusService } from "./bus";
import { TypeRegistry, InstanceRegistry } from "./registry";
import { AuthorityService } from "./authority";
import { NodeRunner, SleepService } from "./runner";
import { logger } from "./logger";
import {
  getDb,
  saveNode,
  saveSubscription,
  deleteNode,
  loadAllNodes,
  loadSubscriptions,
  clearAll,
  updateNodePosition,
  recordHistory,
  getHistory,
  type HistoryEntry,
  type HistoryAction,
} from "./db";
import { loadSeedFile, scanSeedsDirectory, type SeedInfo } from "./seed";
import { LLMRegistry, type ProviderStatus } from "./llm/llm-registry";
import { CLIRegistry, type CLIStatus } from "./llm/cli-registry";

export class BrainService extends EventEmitter {
  static current: BrainService | null = null;

  readonly bus: BusService;
  readonly typeRegistry: TypeRegistry;
  readonly instanceRegistry: InstanceRegistry;
  readonly authority: AuthorityService;
  readonly sleepService: SleepService;

  private readonly runners = new Map<string, NodeRunner>();
  private readonly db: Database.Database;
  private seedsDir?: string;
  private globalRunMode: "auto" | "manual" = "auto";
  readonly llm = LLMRegistry.getInstance();
  readonly cli = CLIRegistry.getInstance();

  constructor(dbPath?: string) {
    super();
    BrainService.current = this;
    this.db = getDb(dbPath);
    this.bus = new BusService();
    this.typeRegistry = new TypeRegistry();
    this.instanceRegistry = new InstanceRegistry();
    this.authority = new AuthorityService();
    this.sleepService = new SleepService(this.bus, this.instanceRegistry);
    this.sleepService.setDb(this.db);

    // Forward events
    this.instanceRegistry.on("node:added", (node: NodeInfo) =>
      this.emit("node:spawned", node),
    );
    this.instanceRegistry.on("node:removed", (node: NodeInfo) =>
      this.emit("node:killed", node),
    );
    this.instanceRegistry.on(
      "node:state_changed",
      (data: { nodeId: string; from: NodeState; to: NodeState }) =>
        this.emit("node:state_changed", data),
    );
    this.bus.on("message:published", (msg) =>
      this.emit("message:published", msg),
    );

    // Centralized history recording — every network mutation is logged
    this.setupHistoryRecording();
  }

  private setupHistoryRecording(): void {
    this.on("node:spawned", (node: NodeInfo) => {
      recordHistory(this.db, {
        action: "node.spawned",
        node_id: node.id,
        node_name: node.name,
        node_type: node.type,
        details: { tags: node.tags, transport: node.transport },
      });
    });

    this.on("node:killed", (data: { nodeId: string; reason?: string }) => {
      recordHistory(this.db, {
        action: "node.killed",
        node_id: data.nodeId,
        details: { reason: data.reason },
      });
    });

    this.on("node:state_changed", (data: { nodeId: string; from: NodeState; to: NodeState }) => {
      const node = this.instanceRegistry.get(data.nodeId);
      const actionMap = new Map<string, HistoryAction>([
        ["stopped", "node.stopped"],
        ["active", "node.started"],
        ["sleeping", "node.stopped"],
      ]);
      const action = actionMap.get(data.to);
      if (action) {
        recordHistory(this.db, {
          action,
          node_id: data.nodeId,
          node_name: node?.name,
          node_type: node?.type,
          details: { from: data.from, to: data.to },
        });
      }
    });
  }

  async spawnNode(
    config: NodeInstanceConfig,
    callerNodeId?: string,
  ): Promise<NodeInfo> {
    // Authority check
    if (callerNodeId) {
      const caller = this.instanceRegistry.get(callerNodeId);
      if (!caller)
        throw new Error(`Caller node ${callerNodeId} not found`);
      if (
        !this.authority.canPerform(caller, "spawn_node")
      ) {
        throw new Error("Insufficient authority to spawn nodes");
      }
      const maxAuth = this.authority.getMaxChildAuthority(caller);
      if (
        config.authority_level !== undefined &&
        config.authority_level > maxAuth
      ) {
        throw new Error(
          `Cannot spawn node with authority ${config.authority_level}, max allowed: ${maxAuth}`,
        );
      }
    }

    // Look up type
    const typeConfig = this.typeRegistry.get(config.type);
    if (!typeConfig) {
      throw new Error(`Unknown node type: ${config.type}`);
    }

    // Load handler
    const typePath = this.typeRegistry.getPath(config.type);
    if (!typePath) throw new Error(`No path for type: ${config.type}`);

    const handler = await this.loadHandler(config.type, typePath);

    // Create node info
    const nodeInfo: NodeInfo = {
      id: uuid(),
      type: config.type,
      name: config.name,
      description: config.description ?? typeConfig.description,
      tags: config.tags ?? typeConfig.tags,
      authority_level:
        config.authority_level ?? typeConfig.default_authority,
      state: NodeState.ACTIVE,
      priority: config.priority ?? typeConfig.default_priority,
      subscriptions: config.subscriptions ?? typeConfig.default_subscriptions,
      transport: config.transport ?? "process",
      position: config.position ?? { x: 0, y: 0 },
      config_overrides: config.config_overrides,
      spawned_by: callerNodeId,
      ttl: config.ttl ? this.sleepService.parseInterval(config.ttl) : undefined,
      created_at: Date.now(),
    };

    // Persist to DB
    saveNode(this.db, {
      id: nodeInfo.id,
      type: nodeInfo.type,
      name: nodeInfo.name,
      description: nodeInfo.description,
      tags: JSON.stringify(nodeInfo.tags),
      authority_level: nodeInfo.authority_level,
      priority: nodeInfo.priority,
      transport: nodeInfo.transport,
      config_overrides: JSON.stringify(config.config_overrides ?? {}),
      position_x: nodeInfo.position.x,
      position_y: nodeInfo.position.y,
      created_at: nodeInfo.created_at,
    });

    for (const sub of nodeInfo.subscriptions) {
      saveSubscription(this.db, {
        node_id: nodeInfo.id,
        topic: sub.topic,
        min_criticality: sub.min_criticality ?? null,
        mailbox_max_size: sub.mailbox?.max_size ?? 100,
        mailbox_retention: sub.mailbox?.retention ?? "latest",
      });
    }

    // Register instance
    this.instanceRegistry.add(nodeInfo);

    // Create subscriptions
    for (const sub of nodeInfo.subscriptions) {
      this.bus.subscribe(nodeInfo.id, sub.topic, {
        mailbox: sub.mailbox,
      });
    }

    // Create and start runner
    const runner = new NodeRunner(
      nodeInfo,
      handler,
      this.bus,
      this.instanceRegistry,
      this.sleepService,
      typeConfig.interval,
      this.globalRunMode,
    );
    this.runners.set(nodeInfo.id, runner);

    // Inject initial message if provided
    if (config.initial_message) {
      this.bus.publish({
        from: "system",
        topic: `node.${nodeInfo.id}.init`,
        type: "text",
        criticality: 5,
        payload: { content: config.initial_message },
      });
    }

    // Handle TTL
    if (nodeInfo.ttl) {
      setTimeout(() => {
        this.killNode(nodeInfo.id, undefined, "TTL expired");
      }, nodeInfo.ttl);
    }

    // Start runner (fire and forget)
    runner.start().catch((err) => {
      logger.error({ err, node: nodeInfo.name }, "Runner crashed");
    });

    return nodeInfo;
  }

  killNode(nodeId: string, callerNodeId?: string, reason?: string): boolean {
    const node = this.instanceRegistry.get(nodeId);
    if (!node) return false;

    if (callerNodeId) {
      const caller = this.instanceRegistry.get(callerNodeId);
      if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
      if (!this.authority.canPerform(caller, "kill_node", node)) {
        throw new Error("Insufficient authority to kill this node");
      }
    }

    const runner = this.runners.get(nodeId);
    if (runner) {
      runner.stop();
      this.runners.delete(nodeId);
    }

    this.bus.removeAllSubscriptions(nodeId);
    this.instanceRegistry.updateState(nodeId, NodeState.TERMINATED);
    this.instanceRegistry.remove(nodeId);

    // Remove from DB
    deleteNode(this.db, nodeId);

    this.emit("node:killed", { nodeId, reason });
    return true;
  }

  stopNode(
    nodeId: string,
    callerNodeId?: string,
    reason?: string,
    bufferMessages = false,
  ): boolean {
    const node = this.instanceRegistry.get(nodeId);
    if (!node) return false;

    if (callerNodeId) {
      const caller = this.instanceRegistry.get(callerNodeId);
      if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
      if (!this.authority.canPerform(caller, "stop_node", node)) {
        throw new Error("Insufficient authority to stop this node");
      }
    }

    const runner = this.runners.get(nodeId);
    if (runner) {
      runner.stop();
    }

    if (!bufferMessages) {
      this.bus.removeAllSubscriptions(nodeId);
    }

    this.instanceRegistry.updateState(nodeId, NodeState.STOPPED);
    return true;
  }

  async startNode(
    nodeId: string,
    callerNodeId?: string,
    message?: string,
  ): Promise<boolean> {
    const node = this.instanceRegistry.get(nodeId);
    if (!node || node.state !== NodeState.STOPPED) return false;

    if (callerNodeId) {
      const caller = this.instanceRegistry.get(callerNodeId);
      if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
      if (!this.authority.canPerform(caller, "start_node", node)) {
        throw new Error("Insufficient authority to start this node");
      }
    }

    // Reload handler
    const typePath = this.typeRegistry.getPath(node.type);
    if (!typePath) return false;

    const handler = await this.loadHandler(node.type, typePath);

    const typeConfig = this.typeRegistry.get(node.type);
    const runner = new NodeRunner(
      node,
      handler,
      this.bus,
      this.instanceRegistry,
      this.sleepService,
      typeConfig?.interval,
      this.globalRunMode,
    );
    this.runners.set(nodeId, runner);

    // Re-create subscriptions if they were removed
    for (const sub of node.subscriptions) {
      this.bus.subscribe(nodeId, sub.topic, { mailbox: sub.mailbox });
    }

    if (message) {
      this.bus.publish({
        from: "system",
        topic: `node.${nodeId}.restart`,
        type: "text",
        criticality: 5,
        payload: { content: message },
      });
    }

    runner.start().catch((err) => {
      logger.error({ err, node: node.name }, "Runner crashed on restart");
    });

    return true;
  }

  wakeNode(nodeId: string, callerNodeId?: string, message?: string): boolean {
    const node = this.instanceRegistry.get(nodeId);
    if (!node || node.state !== NodeState.SLEEPING) return false;

    if (callerNodeId) {
      const caller = this.instanceRegistry.get(callerNodeId);
      if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
      if (!this.authority.canPerform(caller, "wake_node", node)) {
        throw new Error("Insufficient authority to wake this node");
      }
    }

    if (message) {
      this.bus.publish({
        from: callerNodeId ?? "system",
        topic: `node.${nodeId}.wake`,
        type: "text",
        criticality: 5,
        payload: { content: message },
      });
    }

    this.sleepService.wake(nodeId);
    return true;
  }

  getNetworkSnapshot(filter?: {
    tags?: string[];
    state?: NodeState | "all";
    transport?: string;
  }): NodeInfo[] {
    return this.instanceRegistry.list(filter);
  }

  bootstrap(nodesDir: string): void {
    const types = this.typeRegistry.scanDirectory(nodesDir);
    logger.info(
      { count: types.length, types: types.map((t) => t.name) },
      "Registered node types",
    );
  }

  async restore(): Promise<number> {
    const savedNodes = loadAllNodes(this.db);
    let restored = 0;

    for (const saved of savedNodes) {
      const subs = loadSubscriptions(this.db, saved.id);

      if (!this.typeRegistry.has(saved.type)) {
        logger.warn({ type: saved.type, name: saved.name }, "Skipping restore: type not registered");
        continue;
      }

      const typePath = this.typeRegistry.getPath(saved.type);
      if (!typePath) continue;

      const typeConfig = this.typeRegistry.get(saved.type);

      let handler: NodeHandler;
      try {
        handler = await this.loadHandler(saved.type, typePath);
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

      this.instanceRegistry.add(nodeInfo);

      for (const sub of subscriptions) {
        this.bus.subscribe(nodeInfo.id, sub.topic, {
          min_criticality: sub.min_criticality,
          mailbox: sub.mailbox,
        });
      }

      const runner = new NodeRunner(
        nodeInfo,
        handler,
        this.bus,
        this.instanceRegistry,
        this.sleepService,
        typeConfig?.interval,
        this.globalRunMode,
      );
      this.runners.set(nodeInfo.id, runner);

      runner.start().catch((err) => {
        logger.error({ err, node: nodeInfo.name }, "Restored runner crashed");
      });

      restored++;
    }

    if (restored > 0) {
      logger.info({ count: restored }, "Restored nodes from database");
    }

    // Restore sleep states — wake nodes whose timer expired during downtime
    this.sleepService.restoreSleepStates((nodeId) => {
      const runner = this.runners.get(nodeId);
      if (runner) {
        logger.info({ nodeId }, "Restarting runner after sleep restore");
      }
    });

    return restored;
  }

  async seed(filePath: string): Promise<number> {
    // Kill all running nodes first
    this.killAll();

    // Clear DB
    clearAll(this.db);

    // Spawn from seed file
    const configs = loadSeedFile(filePath);
    let spawned = 0;

    for (const config of configs) {
      try {
        await this.spawnNode(config);
        spawned++;
      } catch (err) {
        logger.error({ err, node: config.name }, "Failed to seed node");
      }
    }

    logger.info({ count: spawned, file: filePath }, "Seeded nodes from config");
    recordHistory(this.db, {
      action: "network.seeded",
      details: { file: filePath, count: spawned },
    });
    return spawned;
  }

  killAll(): number {
    const allNodes = this.instanceRegistry.list();
    let killed = 0;

    for (const node of allNodes) {
      const runner = this.runners.get(node.id);
      if (runner) {
        runner.stop();
        this.runners.delete(node.id);
      }
      this.bus.removeAllSubscriptions(node.id);
      this.instanceRegistry.remove(node.id);
      killed++;
    }

    if (killed > 0) {
      logger.info({ count: killed }, "Killed all nodes");
      recordHistory(this.db, {
        action: "network.reset",
        details: { killed },
      });
    }
    return killed;
  }

  resetDb(): void {
    clearAll(this.db);
    logger.info("Database cleared");
  }

  getNetworkHistory(opts?: {
    last?: number;
    action?: HistoryAction;
    node_id?: string;
    since?: number;
  }): HistoryEntry[] {
    return getHistory(this.db, opts);
  }

  updatePosition(nodeId: string, x: number, y: number): boolean {
    const node = this.instanceRegistry.get(nodeId);
    if (!node) return false;
    node.position.x = x;
    node.position.y = y;
    updateNodePosition(this.db, nodeId, x, y);
    return true;
  }

  // === Dev mode ===

  tickNode(nodeId: string): boolean {
    const runner = this.runners.get(nodeId);
    if (!runner) return false;
    runner.tick();
    return true;
  }

  getNodeLogs(nodeId: string, last?: number): Array<{ timestamp: number; level: string; message: string; data?: Record<string, unknown> }> {
    const runner = this.runners.get(nodeId);
    if (!runner) return [];
    return runner.getLogs(last);
  }

  tickAll(): number {
    let ticked = 0;
    for (const [, runner] of this.runners) {
      runner.tick();
      ticked++;
    }
    return ticked;
  }

  setDevMode(enabled: boolean): void {
    const mode = enabled ? "manual" : "auto";
    this.globalRunMode = mode;

    // Switch all existing runners
    for (const [, runner] of this.runners) {
      runner.setRunMode(mode);
    }

    logger.info({ devMode: enabled, runners: this.runners.size }, "Dev mode toggled");
    this.emit("devmode:changed", { enabled });
  }

  isDevMode(): boolean {
    return this.globalRunMode === "manual";
  }

  setSeedsDir(dir: string): void {
    this.seedsDir = dir;
  }

  getSeeds(): SeedInfo[] {
    if (!this.seedsDir) return [];
    const knownTypes = new Set(this.typeRegistry.list().map((t) => t.name));
    return scanSeedsDirectory(this.seedsDir, knownTypes);
  }

  async initializeProviders(): Promise<void> {
    await Promise.allSettled([
      this.llm.initialize(),
      this.cli.initialize(),
    ]);
  }

  getProviderStatuses(): { llm: ProviderStatus[]; cli: CLIStatus[] } {
    return {
      llm: this.llm.getStatuses(),
      cli: this.cli.getStatuses(),
    };
  }

  private async loadHandler(typeName: string, typePath: string): Promise<NodeHandler> {
    try {
      const mod: Record<string, unknown> = await import(require.resolve(typePath)) as Record<string, unknown>;
      const loaded = (mod.handler ?? mod.default) as NodeHandler | undefined;
      if (!loaded) {
        throw new Error(`No handler export in ${typePath}`);
      }
      return loaded;
    } catch (err) {
      throw new Error(`Failed to load handler for type ${typeName}: ${String(err)}`);
    }
  }
}
