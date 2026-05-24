import {
  type NodeInfo,
  type NodeHandler,
  type NodeModule,
  type NodeOnSpawn,
  type NodeTeardown,
  type NodeInstanceConfig,
  type NodeState,
  type NodeTypeConfig,
} from "@brain/sdk";
import type Database from "better-sqlite3";
import EventEmitter from "eventemitter3";
import * as fs from "node:fs";
import * as path from "node:path";
import { BusService, type IBusService, type NatsBusService } from "./bus";
import { replayTrace } from "./brain-replay";
import { TypeRegistry, InstanceRegistry, DynamicTypeScanner, type DynamicScannerOptions } from "./registry";
import { AuthorityService } from "./authority";
import { type BaseRunner, setNodeDataRoot } from "./runner";
import { logger } from "./logger";
import {
  getDb, clearAll, updateNodePosition, updateNodeConfig as dbUpdateNodeConfig, recordHistory, getHistory, saveSubscription, deleteSubscription as dbDeleteSubscription,
  type HistoryEntry, type HistoryAction,
} from "./db";
import {
  applySeed,
  scanAllSeedSources,
  scanSeedsDirectory,
  savePersonalSeed as doSavePersonalSeed,
  deletePersonalSeed as doDeletePersonalSeed,
  type SeedInfo,
  type SeedResult,
} from "./seed";
import { restoreNodes } from "./brain-restore";
import {
  spawnNode as doSpawn, killNode as doKill, stopNode as doStop,
  startNode as doStart, type LifecycleDeps,
} from "./brain-lifecycle";
import { LLMRegistry, type ProviderStatus } from "./llm/llm-registry";
import { CLIRegistry, type CLIStatus } from "./llm/cli-registry";
import { LLMConfigStore } from "./llm/llm-config";
import { StoreService } from "./store";
import { AgentDirectory, type AgentDirectoryOptions } from "./agents";
import { NetworkDirectory } from "./network";
import { resolveHubId } from "./network/hub-identity";
import { MCPBridge } from "./mcp";

/**
 * Cross-realm anchor for `BrainService.current`.
 *
 * Node-handler code (e.g. clock, cron) reaches up for the running
 * brain via `BrainService.current?.bus.publish(...)`. In test runs
 * the framework module gets loaded *twice* — once via Vite's TS
 * resolver for the test file (`packages/core/src/...`) and once via
 * Node's `require()` when a handler in `storeprojects/` is dynamically
 * imported (resolves to `packages/core/dist/...`). Two module instances
 * means two static `current` slots — clock would publish through a
 * BrainService whose `current` is still `null`.
 *
 * Routing `current` through `globalThis` makes the slot itself global,
 * so whichever realm sets it, all readers see the same instance.
 */
const CURRENT_KEY = "__brAInService_current__";

export class BrainService extends EventEmitter {
  static get current(): BrainService | null {
    return ((globalThis as Record<string, unknown>)[CURRENT_KEY] as BrainService | null) ?? null;
  }
  static set current(value: BrainService | null) {
    (globalThis as Record<string, unknown>)[CURRENT_KEY] = value;
  }
  // Typed as the interface so consumers don't depend on the in-memory
  // impl; future NatsBusService swap is a one-line change in the
  // constructor.
  readonly bus: IBusService;
  readonly typeRegistry: TypeRegistry;
  readonly instanceRegistry: InstanceRegistry;
  readonly authority: AuthorityService;
  private dynamicScanner: DynamicTypeScanner | null = null;
  private readonly runners = new Map<string, BaseRunner>();
  /** Nodes this instance dispatched to a remote agent (id → agent_id). */
  private readonly remoteNodes = new Map<string, string>();
  private readonly db: Database.Database;
  private seedsDir?: string;
  /** Root that contains per-store seed dirs (`storeprojects/<store>/seeds/`).
   *  When set, getSeeds() unions root seeds + every store's seeds and
   *  attributes each required type to its source store. */
  private storeprojectsRoot?: string;
  /** Where user-saved "personal" seeds live (one YAML per saved
   *  configuration). Writeable via savePersonalSeed / deletable via
   *  deletePersonalSeed; nothing else gets touched here. */
  private personalSeedsDir?: string;
  private globalRunMode: "auto" | "manual" = "auto";
  readonly llm = LLMRegistry.getInstance();
  readonly cli = CLIRegistry.getInstance();
  llmConfig!: LLMConfigStore;  // initialised in bootstrap() once nodeDataRoot is known
  store!: StoreService;  // wired in bootstrap() once we know siblingsRoot
  readonly agents: AgentDirectory;
  /** Peer-hub registry — merges other machines' `brain.network.snapshot`
   *  feeds so the dashboard can show one machine-grouped view. */
  readonly network: NetworkDirectory;
  readonly mcpBridge: MCPBridge;

  /**
   * @param dbPath SQLite path; falls back to the default in-memory db.
   * @param bus    `IBusService` to wire up. Production callers (the
   *               API + brain-agent) always pass a `NatsBusService`
   *               connected to the broker `BrokerService` started.
   *               Tests may pass a `BusService` (the in-memory test
   *               fixture) when they don't need real routing — if no
   *               bus is provided we fall back to one for that
   *               reason, but production must NOT rely on this.
   * @param opts   Tunables (mostly for tests). `agentDirectory` lets
   *               you shrink the TTL to verify expiry-driven cleanup.
   */
  constructor(
    dbPath?: string,
    bus?: IBusService,
    opts?: { agentDirectory?: AgentDirectoryOptions },
  ) {
    super();
    BrainService.current = this;
    (globalThis as Record<string, unknown>).__brainService = this;
    this.db = getDb(dbPath);
    this.bus = bus ?? new BusService();
    this.typeRegistry = new TypeRegistry();
    this.instanceRegistry = new InstanceRegistry();
    this.authority = new AuthorityService();
    this.agents = new AgentDirectory(this.bus, opts?.agentDirectory);
    this.agents.attach();
    this.network = new NetworkDirectory(this.bus, resolveHubId(this.db));
    this.network.attach();
    this.mcpBridge = new MCPBridge(this.bus);
    this.mcpBridge.install();
    this.agents.on("agent:expired", (ann: { agent_id: string }) => {
      this.dropExpiredAgentNodes(ann.agent_id);
    });
    this.forwardEvents();
    this.setupHistoryRecording();
  }

  /**
   * When an agent stops announcing past its TTL, every remote-spawned
   * node we tracked for it is orphaned. Drop them from the local
   * registry + remoteNodes map so the dashboard's network graph
   * doesn't keep zombies forever. The agent may come back later under
   * a fresh id; the user can re-spawn the nodes manually.
   */
  private dropExpiredAgentNodes(agentId: string): void {
    const orphaned: string[] = [];
    for (const [nodeId, agent] of this.remoteNodes) {
      if (agent === agentId) orphaned.push(nodeId);
    }
    if (orphaned.length === 0) return;
    logger.warn({ agentId, count: orphaned.length }, "agent expired — dropping its remote nodes");
    for (const nodeId of orphaned) {
      this.remoteNodes.delete(nodeId);
      this.instanceRegistry.remove(nodeId);
    }
  }

  private get deps(): LifecycleDeps {
    return {
      db: this.db, bus: this.bus, typeRegistry: this.typeRegistry,
      instanceRegistry: this.instanceRegistry, authority: this.authority,
      runners: this.runners,
      globalRunMode: this.globalRunMode, loadHandler: this.loadHandler.bind(this),
      remoteNodes: this.remoteNodes,
      // Peer-owned node → its hub id, so lifecycle commands route by id to
      // whichever machine actually hosts the node (location-transparent).
      ownerHubOf: (nodeId) => this.network.mergedNodes().find((n) => n.id === nodeId)?.owner_hub?.hub_id,
      peerNodes: () => this.network.mergedNodes(),
      llmRegistry: this.llm,
      llmConfig: this.llmConfig,
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

  // === Network ===

  getNetworkSnapshot(filter?: { tags?: string[]; state?: NodeState | "all"; transport?: string }): NodeInfo[] {
    return this.instanceRegistry.list(filter);
  }

  bootstrap(
    nodesDir: string | string[],
    opts?: { nodeModulesDir?: string; siblingsRoot?: string; nodeDataRoot?: string; dataRoot?: string },
  ): void {
    // Accept either a single path (legacy) or a list. Multiple paths support
    // the cross-repo workspace setup: brAIn ships its catalog under `nodes/`,
    // brAIn-perception under `../brAIn-perception/nodes/`, etc. Each entry
    // is treated as a directory of node subdirs (mirror of the original
    // single-dir scan).
    const dirs = Array.isArray(nodesDir) ? nodesDir : [nodesDir];
    const staticTypes: NodeTypeConfig[] = [];
    for (const dir of dirs) {
      staticTypes.push(...this.typeRegistry.scanDirectory(dir));
    }

    // Initialise the store service once. The siblings root is where the
    // store will clone parent repos. Default: parent of the first nodesDir
    // — but when nodesDir is empty (fresh agent on a workspace with no
    // node libs pulled yet) we fall back to the process cwd so we still
    // boot rather than crashing on `path.resolve(undefined, ...)`.
    const siblingsRoot = opts?.siblingsRoot
      ?? (dirs[0] ? path.resolve(dirs[0], "..", "..") : process.cwd());
    this.store = new StoreService(this.typeRegistry, siblingsRoot);

    // Where all runtime data lives (brain DB, per-node dirs, LLM config,
    // personal seeds). Decoupled from `siblingsRoot` on purpose: siblings
    // are about *where sibling repos clone*, the data root is about *where
    // state persists* — they only coincided by accident. The API pins this
    // to the framework-repo `data/` (next to brain.db); tests fall back to
    // `<siblingsRoot>/data` so quick scripts still work without wiring.
    const dataRoot = opts?.dataRoot ?? path.resolve(siblingsRoot, "data");

    // Per-node data root. Each node's ctx.dataDir resolves to <root>/<nodeId>/.
    const nodeDataRoot = opts?.nodeDataRoot ?? path.resolve(dataRoot, "nodes");
    setNodeDataRoot(nodeDataRoot);

    this.llm.setConfigStore(this.llmConfig = new LLMConfigStore(dataRoot));

    // Discover nodes installed as npm packages under @brain/node-*. Once
    // the perception/memory/etc. domains ship via `pnpm add @brain/node-foo`,
    // they surface here. Default lookup walks up from the framework's own
    // node_modules to the workspace root, hitting both pnpm install
    // layouts (hoisted + isolated).
    const installedTypes: NodeTypeConfig[] = [];
    for (const dir of resolveNodeModulesDirs(opts?.nodeModulesDir)) {
      installedTypes.push(...this.typeRegistry.scanInstalledPackages(dir));
    }

    logger.info(
      {
        static: staticTypes.length,
        installed: installedTypes.length,
        dirs,
        types: [...staticTypes, ...installedTypes].map((t) => t.name),
      },
      "Registered node types",
    );
  }

  startDynamicScanner(opts: Omit<DynamicScannerOptions, "bus" | "typeRegistry"> & Partial<Pick<DynamicScannerOptions, "bus" | "typeRegistry">>): DynamicTypeScanner {
    if (this.dynamicScanner) return this.dynamicScanner;
    this.dynamicScanner = new DynamicTypeScanner({
      ...opts,
      bus: opts.bus ?? this.bus,
      typeRegistry: opts.typeRegistry ?? this.typeRegistry,
    });
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
    return restoreNodes({
      db: this.db, bus: this.bus, typeRegistry: this.typeRegistry,
      instanceRegistry: this.instanceRegistry,
      runners: this.runners, globalRunMode: this.globalRunMode,
      loadHandler: this.loadHandler.bind(this),
      spawnNode: (c, caller) => this.spawnNode(c, caller),
      killNode: (id, caller, reason) => this.killNode(id, caller, reason),
      llmRegistry: this.llm,
      llmConfig: this.llmConfig,
      peerNodes: () => this.network.mergedNodes(),
    });
  }

  // === Seed ===

  /**
   * Apply a seed file. **Non-destructive** by design: existing nodes
   * stay running, only what's missing is added. Implementation lives
   * in `seed/orchestrator.ts`. For a wipe use `killAll()` + `resetDb()`
   * (exposed as `POST /network/reset`).
   */
  async seed(filePath: string, opts?: { merge?: boolean }): Promise<SeedResult> {
    return applySeed(
      {
        db: this.db,
        typeRegistry: this.typeRegistry,
        instanceRegistry: this.instanceRegistry,
        store: this.store,
        spawnNode: (c, caller) => this.spawnNode(c, caller),
        killAll: () => this.killAll(),
      },
      filePath,
      opts,
    );
  }

  killAll(): number {
    // Route through `killNode` so the DB row is deleted alongside the
    // runner / bus / registry teardown. Without this every seed apply
    // leaks rows and the next restart resurrects ghosts via restore().
    const ids = this.instanceRegistry.list().map((n) => n.id);
    let killed = 0;
    for (const id of ids) {
      if (this.killNode(id, undefined, "killAll")) killed++;
    }
    if (killed > 0) recordHistory(this.db, { action: "network.reset", details: { killed } });
    return killed;
  }

  resetDb(): void { clearAll(this.db); }

  // === Queries ===

  getNetworkHistory(o?: { last?: number; action?: HistoryAction; node_id?: string; since?: number }): HistoryEntry[] { return getHistory(this.db, o); }
  setSeedsDir(dir: string): void { this.seedsDir = dir; }
  setStoreprojectsRoot(dir: string): void { this.storeprojectsRoot = dir; }
  setPersonalSeedsDir(dir: string): void { this.personalSeedsDir = dir; }
  getSeeds(): SeedInfo[] {
    const known = new Set(this.typeRegistry.list().map((t) => t.name));
    if (this.storeprojectsRoot) {
      return scanAllSeedSources(this.seedsDir ?? "", this.storeprojectsRoot, known, this.personalSeedsDir);
    }
    return this.seedsDir ? scanSeedsDirectory(this.seedsDir, { knownTypes: known }) : [];
  }

  /**
   * Snapshot the running network and persist it as a personal seed
   * under `<personalSeedsDir>/<slug>.yaml`. Defaults to refusing on
   * name collision; pass `overwrite: true` to clobber.
   */
  savePersonalSeed(displayName: string, opts?: { description?: string; overwrite?: boolean }): { slug: string; path: string } {
    if (!this.personalSeedsDir) {
      throw new Error("Personal seeds directory is not configured");
    }
    const snapshot = this.getNetworkSnapshot();
    return doSavePersonalSeed(this.personalSeedsDir, displayName, snapshot, opts);
  }

  /**
   * Remove a personal seed by its slug. Validates the target really
   * is a personal seed before unlinking — store/root seeds must not
   * be deletable through this surface.
   */
  deletePersonalSeed(slug: string): void {
    if (!this.personalSeedsDir) {
      throw new Error("Personal seeds directory is not configured");
    }
    const target = this.getSeeds().find((s) => s.name === slug);
    if (!target) throw new Error(`Personal seed "${slug}" not found`);
    if (target.source !== "personal") {
      throw new Error(`Refusing to delete "${slug}": only personal seeds can be removed (this one is from ${target.source})`);
    }
    doDeletePersonalSeed(this.personalSeedsDir, slug);
  }
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

  /** Apply a node's config_overrides to the live registry AND persist them,
   *  so a change (model, cli, …) survives an API restart instead of being
   *  reverted to the seeded config by restoreNodes. */
  updateNodeConfig(id: string, overrides: Record<string, unknown>): boolean {
    const n = this.instanceRegistry.get(id);
    if (!n) return false;
    n.config_overrides = overrides;
    dbUpdateNodeConfig(this.db, id, overrides);
    return true;
  }

  /**
   * Live rewiring — add a subscription to a running node. Idempotent: if a
   * sub on the same topic already exists, returns the existing one untouched
   * (no second listener, no double persist). Used by the dashboard's
   * drag-to-connect + side-panel `+ sub`. Persists to the DB so the change
   * survives a restart. Emits `node:rewired` so dashboards re-fetch.
   *
   * `opts.internal` defaults to `true` (private listener, not surfaced as an
   * MCP tool). Pass `internal: false` with an `inputSchema` to promote the
   * sub to a public tool the brain can discover and call.
   */
  addNodeSubscription(
    nodeId: string,
    topic: string,
    opts: { description?: string; inputSchema?: Record<string, unknown>; internal?: boolean; min_criticality?: number } = {},
  ): { added: boolean; existed: boolean; subscription_id: string } {
    const n = this.instanceRegistry.get(nodeId);
    if (!n) throw new Error(`Node not found: ${nodeId}`);
    const existing = this.bus.getSubscriptions(nodeId).find((s) => s.pattern === topic);
    if (existing) return { added: false, existed: true, subscription_id: existing.id };
    const internal = opts.internal ?? true;
    const subId = this.bus.subscribe(nodeId, topic, { min_criticality: opts.min_criticality });
    // Append to the live NodeInfo so /network and snapshots reflect it.
    n.subscriptions = [
      ...n.subscriptions,
      internal
        ? { topic, description: opts.description ?? "added at runtime via dashboard", internal: true, inputSchema: opts.inputSchema }
        : { topic, description: opts.description ?? "added at runtime via dashboard", inputSchema: opts.inputSchema ?? { type: "object" } },
    ];
    saveSubscription(this.db, {
      node_id: nodeId,
      topic,
      description: opts.description ?? "added at runtime via dashboard",
      input_schema: opts.inputSchema ? JSON.stringify(opts.inputSchema) : null,
      min_criticality: opts.min_criticality ?? null,
      // Use the table's DEFAULT 100 / 'latest' — no per-add mailbox tuning
      // exposed in the live-wiring API yet (callers who want it use the
      // initial config.json declaration).
      mailbox_max_size: 100,
      mailbox_retention: "latest",
    });
    recordHistory(this.db, { action: "node.rewired", node_id: nodeId, node_name: n.name, node_type: n.type, details: { op: "add_subscription", topic, internal } });
    this.emit("node:rewired", { nodeId, op: "add_subscription", topic });
    return { added: true, existed: false, subscription_id: subId };
  }

  /** Remove a subscription by topic. Idempotent: returns `removed: false`
   *  if the node wasn't subscribed to that topic in the first place. */
  removeNodeSubscription(nodeId: string, topic: string): { removed: boolean } {
    const n = this.instanceRegistry.get(nodeId);
    if (!n) throw new Error(`Node not found: ${nodeId}`);
    const removedFromBus = this.bus.unsubscribe(nodeId, topic);
    n.subscriptions = n.subscriptions.filter((s) => s.topic !== topic);
    const removedFromDb = dbDeleteSubscription(this.db, nodeId, topic);
    const removed = removedFromBus || removedFromDb;
    if (removed) {
      recordHistory(this.db, { action: "node.rewired", node_id: nodeId, node_name: n.name, node_type: n.type, details: { op: "remove_subscription", topic } });
      this.emit("node:rewired", { nodeId, op: "remove_subscription", topic });
    }
    return { removed };
  }

  /**
   * Per-instance publish list mutation. Stored as a complete list in
   * `config_overrides._publishes` — on first edit we snapshot the type's
   * `default_publishes` so the override is self-contained (the framework
   * doesn't have to merge type + delta at load time). Snapshots advertised
   * on the bus pick the override up via the same `default_publishes` field.
   */
  private currentPublishes(n: NodeInfo): string[] {
    const ov = n.config_overrides?._publishes;
    if (Array.isArray(ov)) return [...ov as string[]];
    return [...(n.default_publishes ?? [])];
  }

  addNodePublish(nodeId: string, topic: string): { added: boolean; existed: boolean } {
    const n = this.instanceRegistry.get(nodeId);
    if (!n) throw new Error(`Node not found: ${nodeId}`);
    const list = this.currentPublishes(n);
    if (list.includes(topic)) return { added: false, existed: true };
    list.push(topic);
    n.default_publishes = list;
    const overrides = { ...(n.config_overrides ?? {}), _publishes: list };
    n.config_overrides = overrides;
    dbUpdateNodeConfig(this.db, nodeId, overrides);
    recordHistory(this.db, { action: "node.rewired", node_id: nodeId, node_name: n.name, node_type: n.type, details: { op: "add_publish", topic } });
    this.emit("node:rewired", { nodeId, op: "add_publish", topic });
    return { added: true, existed: false };
  }

  removeNodePublish(nodeId: string, topic: string): { removed: boolean } {
    const n = this.instanceRegistry.get(nodeId);
    if (!n) throw new Error(`Node not found: ${nodeId}`);
    const before = this.currentPublishes(n);
    const after = before.filter((t) => t !== topic);
    if (after.length === before.length) return { removed: false };
    n.default_publishes = after;
    const overrides = { ...(n.config_overrides ?? {}), _publishes: after };
    n.config_overrides = overrides;
    dbUpdateNodeConfig(this.db, nodeId, overrides);
    recordHistory(this.db, { action: "node.rewired", node_id: nodeId, node_name: n.name, node_type: n.type, details: { op: "remove_publish", topic } });
    this.emit("node:rewired", { nodeId, op: "remove_publish", topic });
    return { removed: true };
  }

  tickNode(id: string): boolean { const r = this.runners.get(id); if (!r) return false; r.tick(); return true; }
  tickAll(): number { let n = 0; for (const [, r] of this.runners) { r.tick(); n++; } return n; }
  getNodeLogs(id: string, last?: number): Array<{ timestamp: number; level: string; message: string; data?: Record<string, unknown> }> { return this.runners.get(id)?.getLogs(last) ?? []; }

  /**
   * Dead-letter queue for a node: every message that was in flight when
   * its handler crashed or timed out. Bounded by the runner (50). For
   * local nodes this returns the runner's buffer synchronously.
   * Use `getNodeDeadLettersAny` to also reach remote nodes via NATS.
   */
  getNodeDeadLetters(id: string): ReturnType<BaseRunner["getDeadLetters"]> {
    return this.runners.get(id)?.getDeadLetters() ?? [];
  }

  /**
   * Dead-letter queue regardless of locality. Local nodes return the
   * sync buffer; remote nodes are queried via NATS request-reply
   * against the hosting agent. Same fallback semantics as
   * `getNodeLogsAny`: empty array on failure rather than throwing.
   */
  async replayTrace(
    traceId: string,
    opts: { intervalMs?: number } = {},
  ): Promise<ReturnType<typeof replayTrace>> {
    return replayTrace(this.bus, traceId, opts);
  }

  async getNodeDeadLettersAny(id: string): Promise<ReturnType<BaseRunner["getDeadLetters"]>> {
    const agentId = this.ownerAgentOf(id);
    if (!agentId) return this.getNodeDeadLetters(id);
    const bus = this.bus as { requestRemote?: typeof NatsBusService.prototype.requestRemote };
    if (!bus.requestRemote) return [];
    try {
      return await bus.requestRemote(`brain.agents.${agentId}.read.dead_letters`, { node_id: id });
    } catch { return []; }
  }

  /**
   * Read logs for a node regardless of locality. Local nodes return
   * synchronously via the runner buffer; remote nodes are fetched via
   * NATS request-reply against the hosting agent. Returns [] if the
   * agent doesn't respond within the timeout (the controller turns
   * that into an empty list rather than 500-ing).
   */
  /**
   * Resolve the owning hub for a node id: it might be a node we spawned
   * remotely (`remoteNodes`) OR a node a peer announced on the snapshot
   * channel (`network.mergedNodes()`). Returns undefined for purely-local
   * nodes — caller short-circuits to the in-process accessor.
   */
  private ownerAgentOf(nodeId: string): string | undefined {
    return this.remoteNodes.get(nodeId)
      ?? this.network.mergedNodes().find((n) => n.id === nodeId)?.owner_hub?.hub_id;
  }

  async getNodeLogsAny(
    id: string,
    last?: number,
  ): Promise<Array<{ timestamp: number; level: string; message: string; data?: Record<string, unknown> }>> {
    const agentId = this.ownerAgentOf(id);
    if (!agentId) return this.getNodeLogs(id, last);
    const bus = this.bus as { requestRemote?: typeof NatsBusService.prototype.requestRemote };
    if (!bus.requestRemote) return [];
    try {
      return await bus.requestRemote(`brain.agents.${agentId}.read.logs`, { node_id: id, last });
    } catch { return []; }
  }

  /**
   * Read mailboxes for a node regardless of locality. Same fallback
   * semantics as `getNodeLogsAny` above.
   */
  async getNodeMailboxesAny(id: string): Promise<ReturnType<BusService["getMailboxes"]>> {
    const agentId = this.ownerAgentOf(id);
    if (!agentId) return this.getNodeMailboxes(id);
    const bus = this.bus as { requestRemote?: typeof NatsBusService.prototype.requestRemote };
    if (!bus.requestRemote) return [];
    try {
      return await bus.requestRemote(`brain.agents.${agentId}.read.mailboxes`, { node_id: id });
    } catch { return []; }
  }

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

  private async loadHandler(_typeName: string, typePath: string): Promise<NodeModule> {
    const mod = await import(require.resolve(typePath)) as Record<string, unknown>;
    const h = (mod.handler ?? mod.default) as NodeHandler | undefined;
    if (!h) throw new Error(`No handler in ${typePath}`);
    const teardown = mod.teardown as NodeTeardown | undefined;
    const onSpawn = mod.onSpawn as NodeOnSpawn | undefined;
    return { handler: h, teardown, onSpawn };
  }
}

/**
 * Find the `node_modules` directories where `@brain/node-*` packages
 * may live. Caller can override with an explicit path; otherwise we
 * walk up from the framework's own `__dirname` collecting every
 * `node_modules/` along the way (pnpm hoists at the workspace root,
 * isolates per-package, sometimes both).
 */
function resolveNodeModulesDirs(override?: string): string[] {
  if (override) return [override];
  const dirs: string[] = [];
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {  // bounded climb
    const nm = path.join(cur, "node_modules");
    if (fs.existsSync(nm) && !dirs.includes(nm)) dirs.push(nm);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}
