import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { BrainService, type SeedInfo } from "@brain/core";

@Controller("network/seeds")
export class SeedsController {
  constructor(private readonly brain: BrainService) {}

  @Get()
  list(): SeedInfo[] {
    return this.brain.getSeeds();
  }

  @Get(":name")
  get(@Param("name") name: string): SeedInfo {
    const seeds = this.brain.getSeeds();
    const seed = seeds.find((s) => s.name === name);
    if (!seed) {
      throw new HttpException("Seed not found", HttpStatus.NOT_FOUND);
    }
    return seed;
  }

  @Post(":name/apply")
  async apply(
    @Param("name") name: string,
    @Query("merge") mergeQuery?: string,
  ): Promise<{ seed: string; spawned: number; skipped: number; killed: number; installed: string[] }> {
    const seeds = this.brain.getSeeds();
    const seed = seeds.find((s) => s.name === name);

    if (!seed) {
      throw new HttpException("Seed not found", HttpStatus.NOT_FOUND);
    }

    if (!seed.valid) {
      throw new HttpException(
        { message: "Seed is invalid", errors: seed.errors },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      const merge = mergeQuery === "true" || mergeQuery === "1";
      const result = await this.brain.seed(seed.path, { merge });
      return { seed: name, ...result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }
}
