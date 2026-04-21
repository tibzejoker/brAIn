import {
  type NodeInfo,
  type NodeHandler,
  type NodeInstanceConfig,
  type NodeState,
} from "@brain/sdk";
import type Database from "better-sqlite3";
import EventEmitter from "eventemitter3";
import { BusService } from "./bus";
import { TypeRegistry, InstanceRegistry, DynamicTypeScanner, type DynamicScannerOptions } from "./registry";
import { AuthorityService } from "./authority";
import { type BaseRunner, SleepService } from "./runner";
import { logger } from "./logger";
import {
  getDb, clearAll, updateNodePosition, recordHistory, getHistory,
  type HistoryEntry, type HistoryAction,
} from "./db";
import { loadSeedFile, scanSeedsDirectory, type SeedInfo } from "./seed";
import { restoreNodes } from "./brain-restore";
import {
  spawnNode as doSpawn, killNode as doKill, stopNode as doStop,
  startNode as doStart, wakeNode as doWake, type LifecycleDeps,
} from "./brain-lifecycle";
import { LLMRegistry, type ProviderStatus } from "./llm/llm-registry";
import { CLIRegistry, type CLIStatus } from "./llm/cli-registry";

export class BrainService extends EventEmitter {
  static current: BrainService | null = null;
  readonly bus: BusService;
  readonly typeRegistry: TypeRegistry;
  readonly instanceRegistry: InstanceRegistry;
  readonly authority: AuthorityService;
  readonly sleepService: SleepService;
  private dynamicScanner: DynamicTypeScanner | null = null;
  private readonly runners = new Map<string, BaseRunner>();
  private readonly db: Database.Database;
  private seedsDir?: string;
  private globalRunMode: "auto" | "manual" = "auto";
  readonly llm = LLMRegistry.getInstance();
  readonly cli = CLIRegistry.getInstance();

  constructor(dbPath?: string) {
    super();
    BrainService.current = this;
    (globalThis as Record<string, unknown>).__brainService = this;
    this.db = getDb(dbPath);
    this.bus = new BusService();
    this.typeRegistry = new TypeRegistry();
    this.instanceRegistry = new InstanceRegistry();
    this.authority = new AuthorityService();
    this.sleepService = new SleepService(this.bus, this.instanceRegistry);
    this.sleepService.setDb(this.db);
    this.forwardEvents();
    this.setupHistoryRecording();
  }

  private get deps(): LifecycleDeps {
    return {
      db: this.db, bus: this.bus, typeRegistry: this.typeRegistry,
      instanceRegistry: this.instanceRegistry, authority: this.authority,
      sleepService: this.sleepService, runners: this.runners,
      globalRunMode: this.globalRunMode, loadHandler: this.loadHandler.bind(this),
    };
  }

  // === Node lifecycle (delegated) ===

  async spawnNode(c: NodeInstanceConfig, caller?: string): Promise<NodeInfo> { return doSpawn(this.deps, c, caller); }

  killNode(id: string, caller?: string, reason?: string): boolean {
    const ok = doKill(this.deps, id, caller, reason);
    if (ok) this.emit("node:killed", { nodeId: id, reason });
    return ok;
  }

  stopNode(id: string, caller?: string, reason?: string, buf = false): boolean { return doStop(this.deps, id, caller, reason, buf); }
  async startNode(id: string, caller?: string, msg?: string): Promise<boolean> { return doStart(this.deps, id, caller, msg); }
  wakeNode(id: string, caller?: string, msg?: string): boolean { return doWake(this.deps, id, caller, msg); }

  // === Network ===

  getNetworkSnapshot(filter?: { tags?: string[]; state?: NodeState | "all"; transport?: string }): NodeInfo[] {
    return this.instanceRegistry.list(filter);
  }

  bootstrap(nodesDir: string): void {
    const types = this.typeRegistry.scanDirectory(nodesDir);
    logger.info({ count: types.length, types: types.map((t) => t.name) }, "Registered node types");
  }

  startDynamicScanner(opts: Omit<DynamicScannerOptions, "bus" | "typeRegistry"> & Partial<Pick<DynamicScannerOptions, "bus" | "typeRegistry">>): DynamicTypeScanner {
    if (this.dynamicScanner) return this.dynamicScanner;
    this.dynamicScanner = new DynamicTypeScanner({
      ...opts,
      bus: opts.bus ?? this.bus,
      typeRegistry: opts.typeRegistry ?? this.typeRegistry,
    } as DynamicScannerOptions);
    this.dynamicScanner.start();
    logger.info({ dir: opts.dynamicDir }, "Dynamic scanner started");
    return this.dynamicScanner;
  }

  stopDynamicScanner(): void {
    if (this.dynamicScanner) {
      this.dynamicScanner.stop();
      this.dynamicScanner = null;
    }
  }

  getDynamicScanner(): DynamicTypeScanner | null { return this.dynamicScanner; }

  async restore(): Promise<number> {
    const restored = await restoreNodes({
      db: this.db, bus: this.bus, typeRegistry: this.typeRegistry,
      instanceRegistry: this.instanceRegistry, sleepService: this.sleepService,
      runners: this.runners, globalRunMode: this.globalRunMode,
      loadHandler: this.loadHandler.bind(this),
    });
    this.sleepService.restoreSleepStates((nodeId) => { logger.info({ nodeId }, "Runner wake after restore"); });
    return restored;
  }

  // === Seed ===

  async seed(filePath: string): Promise<number> {
    this.killAll();
    clearAll(this.db);
    const configs = loadSeedFile(filePath);
    let spawned = 0;
    for (const config of configs) {
      try { await this.spawnNode(config); spawned++; }
      catch (err) { logger.error({ err, node: config.name }, "Failed to seed"); }
    }
    recordHistory(this.db, { action: "network.seeded", details: { file: filePath, count: spawned } });
    return spawned;
  }

  killAll(): number {
    const all = this.instanceRegistry.list();
    for (const n of all) {
      const r = this.runners.get(n.id);
      if (r) { r.stop(); this.runners.delete(n.id); }
      this.bus.removeAllSubscriptions(n.id);
      this.instanceRegistry.remove(n.id);
    }
    if (all.length > 0) recordHistory(this.db, { action: "network.reset", details: { killed: all.length } });
    return all.length;
  }

  resetDb(): void { clearAll(this.db); }

  // === Queries ===

  getNetworkHistory(o?: { last?: number; action?: HistoryAction; node_id?: string; since?: number }): HistoryEntry[] { return getHistory(this.db, o); }
  setSeedsDir(dir: string): void { this.seedsDir = dir; }
  getSeeds(): SeedInfo[] { return this.seedsDir ? scanSeedsDirectory(this.seedsDir, new Set(this.typeRegistry.list().map((t) => t.name))) : []; }
  async initializeProviders(): Promise<void> { await Promise.allSettled([this.llm.initialize(), this.cli.initialize()]); }
  getProviderStatuses(): { llm: ProviderStatus[]; cli: CLIStatus[] } { return { llm: this.llm.getStatuses(), cli: this.cli.getStatuses() }; }

  // === Position / Dev mode / Logs ===

  updatePosition(id: string, x: number, y: number): boolean {
    const n = this.instanceRegistry.get(id);
    if (!n) return false;
    n.position.x = x; n.position.y = y;
    updateNodePosition(this.db, id, x, y);
    return true;
  }

  tickNode(id: string): boolean { const r = this.runners.get(id); if (!r) return false; r.tick(); return true; }
  tickAll(): number { let n = 0; for (const [, r] of this.runners) { r.tick(); n++; } return n; }
  getNodeLogs(id: string, last?: number): Array<{ timestamp: number; level: string; message: string; data?: Record<string, unknown> }> { return this.runners.get(id)?.getLogs(last) ?? []; }

  setDevMode(on: boolean): void {
    this.globalRunMode = on ? "manual" : "auto";
    for (const [, r] of this.runners) r.setRunMode(this.globalRunMode);
    this.emit("devmode:changed", { enabled: on });
  }

  isDevMode(): boolean { return this.globalRunMode === "manual"; }

  getNodeMailboxes(nodeId: string): ReturnType<BusService["getMailboxes"]> { return this.bus.getMailboxes(nodeId); }

  // === Internal ===

  private forwardEvents(): void {
    this.instanceRegistry.on("node:added", (n: NodeInfo) => this.emit("node:spawned", n));
    this.instanceRegistry.on("node:removed", (n: NodeInfo) => this.emit("node:killed", n));
    this.instanceRegistry.on("node:state_changed", (d: { nodeId: string; from: NodeState; to: NodeState }) => this.emit("node:state_changed", d));
    this.bus.on("message:published", (m) => this.emit("message:published", m));
  }

  private setupHistoryRecording(): void {
    this.on("node:spawned", (n: NodeInfo) => { recordHistory(this.db, { action: "node.spawned", node_id: n.id, node_name: n.name, node_type: n.type, details: { tags: n.tags } }); });
    this.on("node:killed", (d: { nodeId: string; reason?: string }) => { recordHistory(this.db, { action: "node.killed", node_id: d.nodeId, details: { reason: d.reason } }); });
    this.on("node:state_changed", (d: { nodeId: string; from: NodeState; to: NodeState }) => {
      const n = this.instanceRegistry.get(d.nodeId);
      const map = new Map<string, HistoryAction>([["stopped", "node.stopped"], ["active", "node.started"], ["sleeping", "node.stopped"]]);
      const a = map.get(d.to);
      if (a) recordHistory(this.db, { action: a, node_id: d.nodeId, node_name: n?.name, node_type: n?.type, details: { from: d.from, to: d.to } });
    });
  }

  private async loadHandler(_typeName: string, typePath: string): Promise<NodeHandler> {
    const mod = await import(require.resolve(typePath)) as Record<string, unknown>;
    const h = (mod.handler ?? mod.default) as NodeHandler | undefined;
    if (!h) throw new Error(`No handler in ${typePath}`);
    return h;
  }
}
