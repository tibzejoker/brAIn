import { Module, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { BrainService, BrokerService, NatsBusService, readBrokerPrefs, readExternalBrokerPrefs, getDb, getSetting, setSetting } from "@brain/core";
import { randomBytes } from "node:crypto";
import { NodesController } from "./rest/nodes.controller";
import { TypesController } from "./rest/types.controller";
import { NetworkController } from "./rest/network.controller";
import { SeedsController } from "./rest/seeds.controller";
import { NodeUiController } from "./rest/node-ui.controller";
import { StoreController } from "./rest/store.controller";
import { AgentsController } from "./rest/agents.controller";
import { MCPOAuthController } from "./rest/mcp-oauth.controller";
import { MCPController } from "./rest/mcp.controller";
import { LLMController } from "./rest/llm.controller";
import { ToolsController } from "./rest/tools.controller";
import { DashboardGateway } from "./ws/dashboard.gateway";
import * as path from "path";
import * as fs from "fs";

// Resolve paths relative to monorepo root, not the api package cwd
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

function resolveFromRoot(envVar: string | undefined, fallback: string): string {
  const raw = envVar ?? fallback;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(MONOREPO_ROOT, raw);
}

/** data/broker.json — persisted bind preference, dashboard-toggleable. */
export const BROKER_PREFS_PATH = resolveFromRoot(process.env.BRAIN_BROKER_PREFS_PATH, "data/broker.json");
export const EXTERNAL_BROKER_PREFS_PATH = resolveFromRoot(process.env.BRAIN_EXTERNAL_BROKER_PREFS_PATH, "data/external-broker.json");

/**
 * Read the persisted broker auth token, or generate + persist one.
 * 32 bytes of randomness → 64 hex chars. Single token model: every
 * brain-agent uses it via BRAIN_NATS_TOKEN. Rotation = overwrite +
 * restart (UI exposes a button later).
 */
export function ensureBrokerToken(dbPath: string): string {
  const db = getDb(dbPath);
  let tok = getSetting(db, "broker_token");
  if (!tok) {
    tok = randomBytes(32).toString("hex");
    setSetting(db, "broker_token", tok);
  }
  return tok;
}

// One BrokerService per API process. Started before BrainService so
// the bus has a NATS URL to connect to. Held on AppModule so we can
// stop it cleanly on shutdown.
const brokerProvider = {
  provide: BrokerService,
  useFactory: async (): Promise<BrokerService> => {
    const log = new Logger("BrokerService");
    // External-broker source priority:
    //   1. BRAIN_NATS_URL env var (highest — for explicit overrides)
    //   2. data/external-broker.json (written by the dashboard's
    //      "Join existing hub" flow; survives restart)
    //   3. neither → embedded mode (spawn local nats-server)
    const envExternalUrl = process.env.BRAIN_NATS_URL;
    const fileExternal = envExternalUrl ? null : readExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH);
    const externalUrl = envExternalUrl ?? fileExternal?.url;
    const prefs = readBrokerPrefs(BROKER_PREFS_PATH);
    const dbPath = resolveFromRoot(process.env.BRAIN_DB_PATH, "data/brain.db");
    // External mode skips local-token generation — the caller (env or
    // persisted file) brings the token they want to authenticate with.
    const authToken = externalUrl
      ? (process.env.BRAIN_NATS_TOKEN ?? fileExternal?.token)
      : ensureBrokerToken(dbPath);
    // Pin the broker port via BRAIN_BROKER_PORT — useful when remote
    // agents need a stable URL across API restarts (token rotation,
    // bind toggle, etc.). Defaults to a free port picked by the OS.
    const port = process.env.BRAIN_BROKER_PORT
      ? Number(process.env.BRAIN_BROKER_PORT)
      : undefined;
    const broker = new BrokerService({ externalUrl, host: prefs.bindAddress, port, authToken });
    const r = await broker.start();
    log.log(`NATS bus on ${r.url} (${r.mode}, bound to ${prefs.bindAddress}${authToken ? ", auth: on" : ""})`);
    return broker;
  },
};

const brainServiceProvider = {
  provide: BrainService,
  inject: [BrokerService],
  useFactory: async (broker: BrokerService): Promise<BrainService> => {
    const dbPath = resolveFromRoot(process.env.BRAIN_DB_PATH, "data/brain.db");

    const url = broker.getUrl();
    if (!url) throw new Error("broker has no URL — start() was not awaited");

    // Embedded broker → use the token we generated. External broker →
    // BRAIN_NATS_TOKEN env wins; fall back to the token persisted in
    // data/external-broker.json (written by the dashboard's join flow).
    const token = broker.getMode() === "embedded"
      ? getSetting(getDb(dbPath), "broker_token") ?? undefined
      : (process.env.BRAIN_NATS_TOKEN ?? readExternalBrokerPrefs(EXTERNAL_BROKER_PREFS_PATH)?.token);
    const natsBus = new NatsBusService({
      url,
      prefix: process.env.BRAIN_NATS_PREFIX ?? "brain",
      token,
    });
    await natsBus.connect();

    const brain = new BrainService(dbPath, natsBus);

    const nodesDir = resolveFromRoot(process.env.BRAIN_NODES_DIR, "nodes");
    // Extra node directories (sibling repos, e.g. ../brAIn-perception/nodes).
    // BRAIN_EXTRA_NODES_DIRS is path-list separated by `:` (or `;` on win).
    // The default falls back to the conventional sibling paths so the local
    // dev experience "just works" once you check out brAIn-perception next
    // to brAIn — no env config needed.
    const extras = (process.env.BRAIN_EXTRA_NODES_DIRS ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .map((p) => p.trim()).filter(Boolean)
      .map((p) => resolveFromRoot(p, p));
    // Auto-discover bundle repos. The "grouped" layout has every node
    // bundle under `<wrapper>/storeprojects/brAIn-<X>/`, the legacy
    // "flat" layout puts them as direct siblings of brAIn/. We scan
    // both — and list child repos by name instead of hardcoding them,
    // so adding a marketplace bundle doesn't require editing this file.
    const candidates = [
      path.resolve(MONOREPO_ROOT, "..", "storeprojects"),
      path.resolve(MONOREPO_ROOT, ".."),
    ];
    const conventional: string[] = [];
    const seen = new Set<string>();
    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("brAIn-")) continue;
        // brAIn-store is the registry repo, brAIn-mobile is an app —
        // neither hosts brAIn node types.
        if (entry.name === "brAIn-store" || entry.name === "brAIn-mobile") continue;
        const nodesDir = path.resolve(root, entry.name, "nodes");
        if (!fs.existsSync(nodesDir) || seen.has(nodesDir)) continue;
        seen.add(nodesDir);
        conventional.push(nodesDir);
      }
    }
    const allExtras = [...extras, ...conventional].filter((p) => {
      try { return path.resolve(p) !== path.resolve(nodesDir) && require("fs").existsSync(p); }
      catch { return false; }
    });
    brain.bootstrap([nodesDir, ...allExtras]);
    // Passively watch every static node directory for new folders so a
    // freshly added & built node auto-registers without an API restart.
    brain.startDynamicScanner({
      dynamicDir: path.join(nodesDir, "_dynamic"),
      passiveDirs: [nodesDir, ...allExtras],
    });

    const seedsDir = resolveFromRoot(process.env.BRAIN_SEEDS_DIR, "seeds");
    brain.setSeedsDir(seedsDir);
    // Pointer to the storeprojects root so getSeeds() can union the
    // root seeds/ dir with every <store>/seeds/ that ships with an
    // installed store-repo. Each store's templates become discoverable
    // automatically the moment the store is cloned locally.
    brain.setStoreprojectsRoot(path.resolve(MONOREPO_ROOT, "..", "storeprojects"));
    // Personal seeds live next to the framework DB so they share the
    // same backup / data-root surface as everything else. The folder
    // is created lazily on the first save.
    brain.setPersonalSeedsDir(path.resolve(MONOREPO_ROOT, "..", "data", "seeds"));

    return brain;
  },
};

@Module({
  controllers: [NodesController, TypesController, NetworkController, SeedsController, NodeUiController, StoreController, AgentsController, MCPOAuthController, MCPController, LLMController, ToolsController],
  providers: [brokerProvider, brainServiceProvider, DashboardGateway],
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("AppModule");

  constructor(
    private readonly brain: BrainService,
    private readonly broker: BrokerService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Tear down in reverse: bus first (drain in-flight), then broker.
    try { await (this.brain.bus as { close?: () => Promise<void> }).close?.(); }
    catch (err) { this.log.warn(`bus close failed: ${String(err)}`); }
    try { await this.broker.stop(); }
    catch (err) { this.log.warn(`broker stop failed: ${String(err)}`); }
  }

  async onModuleInit(): Promise<void> {
    // Initialize LLM + CLI providers (non-blocking checks)
    await this.brain.initializeProviders();
    const statuses = this.brain.getProviderStatuses();
    const llmAvail = statuses.llm.filter((s) => s.available).map((s) => s.name);
    const cliAvail = statuses.cli.filter((s) => s.available).map((s) => s.name);
    this.log.log(`LLM providers: ${llmAvail.length > 0 ? llmAvail.join(", ") : "none"}`);
    this.log.log(`CLI agents: ${cliAvail.length > 0 ? cliAvail.join(", ") : "none"}`);

    // Restore persisted nodes from DB
    const restored = await this.brain.restore();
    if (restored > 0) {
      this.log.log(`Restored ${restored} nodes from database`);
    }

    // Auto-seed from default if DB is empty. Fire-and-forget: a fresh
    // install has to clone+install several sister repos which can take
    // 30-90s. Blocking onModuleInit on that delays app.listen(), the
    // dashboard's wait-on times out, and the user sees nothing.
    // Instead we let listen() happen right away and the seeded nodes
    // appear in the dashboard via Socket.IO as they spawn.
    // README promises "boots empty (zero nodes)" — failures are logged
    // and the user can pick a seed from the dashboard.
    if (restored === 0) {
      const seeds = this.brain.getSeeds();
      const defaultSeed = seeds.find((s) => s.name === "default" && s.valid);
      if (defaultSeed) {
        void this.brain.seed(defaultSeed.path).then(
          (r) => this.log.log(
            `Seeded ${r.spawned} nodes from ${defaultSeed.filename}`
            + (r.installed.length > 0 ? ` (installed: ${r.installed.join(", ")})` : "")
            + (r.skipped > 0 ? ` (skipped ${r.skipped} pre-existing)` : ""),
          ),
          (err: unknown) => this.log.warn(
            `default seed apply failed (booting empty — apply a seed from the dashboard): ${String(err)}`,
          ),
        );
      }
    }
  }
}
