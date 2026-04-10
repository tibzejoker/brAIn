import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { BrainService } from "@brain/core";
import {
  type NodeInstanceConfig,
  type NodeInfo,
  type NodeState,
} from "@brain/sdk";

@Controller("nodes")
export class NodesController {
  constructor(private readonly brain: BrainService) {}

  @Get()
  list(
    @Query("state") state?: string,
    @Query("tags") tags?: string,
    @Query("transport") transport?: string,
  ): NodeInfo[] {
    return this.brain.getNetworkSnapshot({
      state: (state ?? "all") as NodeState | "all",
      tags: tags ? tags.split(",") : undefined,
      transport,
    });
  }

  @Get(":id")
  get(@Param("id") id: string): Omit<NodeInfo, "subscriptions"> & { subscriptions: Array<{ id: string; pattern: string }> } {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) {
      throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    }

    return {
      ...node,
      subscriptions: this.brain.bus.getSubscriptions(id),
    };
  }

  @Post()
  async spawn(@Body() config: NodeInstanceConfig): Promise<NodeInfo> {
    try {
      return await this.brain.spawnNode(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(":id")
  kill(
    @Param("id") id: string,
    @Body("reason") reason?: string,
  ): { killed: boolean; node_id: string } {
    const killed = this.brain.killNode(id, undefined, reason);
    if (!killed) {
      throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    }
    return { killed: true, node_id: id };
  }

  @Post(":id/stop")
  stop(
    @Param("id") id: string,
    @Body("reason") reason?: string,
    @Body("buffer_messages") bufferMessages?: boolean,
  ): { stopped: boolean; node_id: string } {
    const stopped = this.brain.stopNode(id, undefined, reason, bufferMessages);
    if (!stopped) {
      throw new HttpException("Node not found or not active", HttpStatus.NOT_FOUND);
    }
    return { stopped: true, node_id: id };
  }

  @Post(":id/start")
  async start(
    @Param("id") id: string,
    @Body("message") message?: string,
  ): Promise<{ started: boolean; node_id: string }> {
    const started = await this.brain.startNode(id, undefined, message);
    if (!started) {
      throw new HttpException("Node not found or not stopped", HttpStatus.NOT_FOUND);
    }
    return { started: true, node_id: id };
  }

  @Post(":id/wake")
  wake(
    @Param("id") id: string,
    @Body("message") message?: string,
  ): { woken: boolean; node_id: string } {
    const woken = this.brain.wakeNode(id, undefined, message);
    if (!woken) {
      throw new HttpException("Node not found or not sleeping", HttpStatus.NOT_FOUND);
    }
    return { woken: true, node_id: id };
  }

  @Patch(":id/position")
  updatePosition(
    @Param("id") id: string,
    @Body() body: { x: number; y: number },
  ): { updated: boolean; node_id: string } {
    const updated = this.brain.updatePosition(id, body.x, body.y);
    if (!updated) {
      throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    }
    return { updated: true, node_id: id };
  }
}
