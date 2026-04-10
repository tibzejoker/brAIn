import { Module, Logger, type OnModuleInit } from "@nestjs/common";
import { BrainService } from "@brain/core";
import { NodesController } from "./rest/nodes.controller";
import { TypesController } from "./rest/types.controller";
import { NetworkController } from "./rest/network.controller";
import { SeedsController } from "./rest/seeds.controller";
import { DashboardGateway } from "./ws/dashboard.gateway";
import * as path from "path";

const brainServiceProvider = {
  provide: BrainService,
  useFactory: (): BrainService => {
    const dbPath = process.env.BRAIN_DB_PATH ?? undefined;
    const brain = new BrainService(dbPath);

    const nodesDir = path.resolve(__dirname, "../../../nodes");
    brain.bootstrap(nodesDir);

    const seedsDir = process.env.BRAIN_SEEDS_DIR
      ?? path.resolve(__dirname, "../../../seeds");
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
