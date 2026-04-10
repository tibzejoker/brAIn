import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { BrainService } from "@brain/core";
import type { NodeTypeConfig } from "@brain/sdk";

interface TypeDetail extends NodeTypeConfig {
  active_instances: number;
  instances: Array<{ id: string; name: string; state: string }>;
}

@Controller("types")
export class TypesController {
  constructor(private readonly brain: BrainService) {}

  @Get()
  list(
    @Query("origin") origin?: string,
    @Query("tags") tags?: string,
  ): NodeTypeConfig[] {
    return this.brain.typeRegistry.list({
      origin: origin as "static" | "dynamic" | undefined,
      tags: tags ? tags.split(",") : undefined,
    });
  }

  @Get(":name")
  get(@Param("name") name: string): TypeDetail {
    const type = this.brain.typeRegistry.get(name);
    if (!type) {
      throw new HttpException("Type not found", HttpStatus.NOT_FOUND);
    }

    const instances = this.brain.instanceRegistry.list({ type: name });
    return {
      ...type,
      active_instances: instances.length,
      instances: instances.map((i) => ({
        id: i.id,
        name: i.name,
        state: i.state,
      })),
    };
  }

  @Post("register")
  register(@Body("path") dirPath: string): { type: string; status: string } {
    try {
      const config = this.brain.typeRegistry.register(dirPath);
      return { type: config.name, status: "registered" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(":name")
  unregister(
    @Param("name") name: string,
    @Body("kill_instances") killInstances?: boolean,
  ): { unregistered: boolean; type: string } {
    if (killInstances) {
      const instances = this.brain.instanceRegistry.list({ type: name });
      for (const inst of instances) {
        this.brain.killNode(inst.id, undefined, "Type unregistered");
      }
    }

    const removed = this.brain.typeRegistry.unregister(name);
    if (!removed) {
      throw new HttpException("Type not found", HttpStatus.NOT_FOUND);
    }
    return { unregistered: true, type: name };
  }
}
