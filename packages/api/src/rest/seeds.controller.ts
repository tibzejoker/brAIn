import {
  Controller,
  Get,
  Post,
  Param,
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
  async apply(@Param("name") name: string): Promise<{ seeded: number; seed: string }> {
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
      const seeded = await this.brain.seed(seed.path);
      return { seeded, seed: name };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }
}
