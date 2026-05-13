import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
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

  /**
   * Snapshot the running network and write it as a personal seed.
   * Body: `{ name, description?, overwrite? }`. Returns the slug
   * the file was saved under (sluggified from `name`).
   */
  @Post()
  save(
    @Body() body: { name?: string; description?: string; overwrite?: boolean } | undefined,
  ): { slug: string; path: string } {
    const name = body?.name?.trim();
    if (!name) {
      throw new HttpException("Missing 'name' in request body", HttpStatus.BAD_REQUEST);
    }
    try {
      return this.brain.savePersonalSeed(name, {
        description: body?.description,
        overwrite: body?.overwrite,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Collisions are the most common failure mode; surface them as
      // 409 so the dashboard can prompt for a new name.
      const status = /already exists/i.test(message) ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new HttpException(message, status);
    }
  }

  /**
   * Delete a personal seed by slug. Refuses to touch store/root seeds
   * — those are owned by their repo / framework and removing them
   * here would either be wrong or only effective until next restart.
   */
  @Delete(":name")
  remove(@Param("name") name: string): { deleted: string } {
    try {
      this.brain.deletePersonalSeed(name);
      return { deleted: name };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /only personal seeds/i.test(message)
        ? HttpStatus.FORBIDDEN
        : /not found/i.test(message)
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
      throw new HttpException(message, status);
    }
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
