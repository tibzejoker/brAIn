import { Module, Logger, type OnModuleInit } from "@nestjs/common";
import { BrainService } from "@brain/core";
import { NodesController } from "./rest/nodes.controller";
import { TypesController } from "./rest/types.controller";
import { NetworkController } from "./rest/network.controller";
import { SeedsController } from "./rest/seeds.controller";
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
  useFactory: (): BrainService => {
    const dbPath = resolveFromRoot(process.env.BRAIN_DB_PATH, "data/brain.db");
    const brain = new BrainService(dbPath);

    const nodesDir = resolveFromRoot(process.env.BRAIN_NODES_DIR, "nodes");
    brain.bootstrap(nodesDir);

    const seedsDir = resolveFromRoot(process.env.BRAIN_SEEDS_DIR, "seeds");
    brain.setSeedsDir(seedsDir);

    return brain;
  },
};

@Module({
  controllers: [NodesController, TypesController, NetworkController, SeedsController],
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
        const seeded = await this.brain.seed(defaultSeed.path);
        this.log.log(`Seeded ${seeded} nodes from ${defaultSeed.filename}`);
      }
    }
  }
}
