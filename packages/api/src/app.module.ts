import { Module, Logger, type OnModuleInit } from "@nestjs/common";
import { BrainService, NatsBusService } from "@brain/core";
import { NodesController } from "./rest/nodes.controller";
import { TypesController } from "./rest/types.controller";
import { NetworkController } from "./rest/network.controller";
import { SeedsController } from "./rest/seeds.controller";
import { NodeUiController } from "./rest/node-ui.controller";
import { StoreController } from "./rest/store.controller";
import { AgentsController } from "./rest/agents.controller";
import { MCPOAuthController } from "./rest/mcp-oauth.controller";
import { MCPController } from "./rest/mcp.controller";
import { DashboardGateway } from "./ws/dashboard.gateway";
import * as path from "path";

// Resolve paths relative to monorepo root, not the api package cwd
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

function resolveFromRoot(envVar: string | undefined, fallback: string): string {
  const raw = envVar ?? fallback;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(MONOREPO_ROOT, raw);
}

const brainServiceProvider = {
  provide: BrainService,
  useFactory: async (): Promise<BrainService> => {
    const dbPath = resolveFromRoot(process.env.BRAIN_DB_PATH, "data/brain.db");

    // Optional NATS wiring: when BRAIN_NATS_URL is set, the API joins the
    // distributed bus so brain-agents on other hosts share its topics.
    // Without it, BrainService falls back to its in-process BusService.
    let natsBus: NatsBusService | undefined;
    const natsUrl = process.env.BRAIN_NATS_URL;
    if (natsUrl) {
      const log = new Logger("AppModule");
      natsBus = new NatsBusService({
        url: natsUrl,
        prefix: process.env.BRAIN_NATS_PREFIX ?? "brain",
        token: process.env.BRAIN_NATS_TOKEN,
      });
      await natsBus.connect();
      log.log(`Joined NATS bus at ${natsUrl}`);
    }

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
    const conventional = [
      path.resolve(MONOREPO_ROOT, "..", "brAIn-perception", "nodes"),
      path.resolve(MONOREPO_ROOT, "..", "brAIn-memory", "nodes"),
      path.resolve(MONOREPO_ROOT, "..", "brAIn-reasoning", "nodes"),
      path.resolve(MONOREPO_ROOT, "..", "brAIn-tools", "nodes"),
    ];
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

    return brain;
  },
};

@Module({
  controllers: [NodesController, TypesController, NetworkController, SeedsController, NodeUiController, StoreController, AgentsController, MCPOAuthController, MCPController],
  providers: [brainServiceProvider, DashboardGateway],
})
export class AppModule implements OnModuleInit {
  private readonly log = new Logger("AppModule");

  constructor(private readonly brain: BrainService) {}

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

    // Auto-seed from default if DB is empty
    if (restored === 0) {
      const seeds = this.brain.getSeeds();
      const defaultSeed = seeds.find((s) => s.name === "default" && s.valid);
      if (defaultSeed) {
        const r = await this.brain.seed(defaultSeed.path);
        this.log.log(
          `Seeded ${r.spawned} nodes from ${defaultSeed.filename}`
          + (r.installed.length > 0 ? ` (installed: ${r.installed.join(", ")})` : "")
          + (r.skipped > 0 ? ` (skipped ${r.skipped} pre-existing)` : ""),
        );
      }
    }
  }
}
