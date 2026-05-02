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

  @Patch(":id/config")
  updateConfig(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ): { updated: boolean; node_id: string; config_overrides: Record<string, unknown> } {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) {
      throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    }
    const overrides = node.config_overrides ?? {};
    for (const [key, value] of Object.entries(body)) {
      if (value === null) {
        delete overrides[key];
      } else {
        overrides[key] = value;
      }
    }
    node.config_overrides = overrides;
    // Type-aware side effects after a config change. Publishing from
    // `system.api` (not the node id) keeps anti-loop happy so the
    // node actually receives its own reload signal.
    //
    // mcp-config: when its global `mcpServers` map changes, ask the
    // manager to reconcile its mcp-server children.
    if (node.type === "mcp-config" && "mcpServers" in body) {
      this.brain.bus.publish({
        from: "system.api",
        topic: "mcp.config.reload",
        type: "text", criticality: 1,
        payload: { content: JSON.stringify({ node_id: id }) },
        metadata: { node_id: id },
      });
    }
    // mcp-export: rebuild the HTTP server when port or tools change.
    if (node.type === "mcp-export" && ("port" in body || "tools" in body)) {
      this.brain.bus.publish({
        from: "system.api",
        topic: "mcp.export.reload",
        type: "text", criticality: 1,
        payload: { content: JSON.stringify({ node_id: id }) },
        metadata: { node_id: id },
      });
    }
    return { updated: true, node_id: id, config_overrides: overrides };
  }

  @Post(":id/tick")
  tick(@Param("id") id: string): { ticked: boolean; node_id: string } {
    const ticked = this.brain.tickNode(id);
    if (!ticked) {
      throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    }
    return { ticked: true, node_id: id };
  }

  @Get(":id/logs")
  async logs(
    @Param("id") id: string,
    @Query("last") last?: string,
  ): Promise<Array<{ timestamp: number; level: string; message: string; data?: Record<string, unknown> }>> {
    return this.brain.getNodeLogsAny(id, last ? parseInt(last, 10) : undefined);
  }

  @Get(":id/mailboxes")
  async mailboxes(@Param("id") id: string): Promise<Array<{
    pattern: string; total: number; unread: number;
    messages: Array<{ id: string; topic: string; criticality: number; from: string; timestamp: number; preview: string }>;
  }>> {
    return this.brain.getNodeMailboxesAny(id);
  }

  /**
   * Messages in flight when the handler crashed or timed out — the
   * dead-letter queue. Bounded ring of 50 entries per node. Routes
   * via NATS request-reply when the node lives on a remote agent.
   */
  @Get(":id/dead-letters")
  async deadLetters(@Param("id") id: string): Promise<ReturnType<BrainService["getNodeDeadLetters"]>> {
    return this.brain.getNodeDeadLettersAny(id);
  }
}
