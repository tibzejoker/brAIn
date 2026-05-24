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
import { BrainService, type NatsBusService } from "@brain/core";
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
    const local = this.brain.instanceRegistry.get(id);
    if (local) {
      return { ...local, subscriptions: this.brain.bus.getSubscriptions(id) };
    }
    // Peer-owned: fall back to the merged network view so the side panel
    // can open on a remote node (kill/stop/start + config edit then route
    // via NATS to the owning hub — the lifecycle helpers already handle
    // this for us as long as the controller's lookup succeeds here).
    const peer = this.brain.network.mergedNodes().find((n) => n.id === id);
    if (peer) {
      // mergedNodes() keeps the raw Subscription[] shape ({id, topic, …});
      // reshape to {id, pattern} so the side panel's wiring matches what
      // it receives for local nodes via bus.getSubscriptions(id).
      return {
        ...peer,
        subscriptions: peer.subscriptions.map((s) => ({ id: `${peer.id}:${s.topic}`, pattern: s.topic })),
      };
    }
    throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
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
  async updateConfig(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ updated: boolean; node_id: string; config_overrides: Record<string, unknown> }> {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) {
      // Peer-owned: forward the patch over NATS to the owning hub. Same
      // merge contract (null clears, anything else overwrites) — the
      // owner-side handler in agent-presence applies it via the local
      // updateNodeConfig and persists.
      const peer = this.brain.network.mergedNodes().find((n) => n.id === id);
      const ownerHub = peer?.owner_hub?.hub_id;
      if (!ownerHub) {
        throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
      }
      const bus = this.brain.bus as { requestRemote?: NatsBusService["requestRemote"] };
      if (!bus.requestRemote) {
        throw new HttpException("Bus does not support remote calls", HttpStatus.NOT_IMPLEMENTED);
      }
      const reply = await bus.requestRemote<{ ok: boolean; error?: string; config_overrides?: Record<string, unknown> }>(
        `brain.agents.${ownerHub}.update_config`,
        { node_id: id, patch: body },
      );
      if (!reply.ok) {
        throw new HttpException(reply.error ?? "Remote config update failed", HttpStatus.BAD_GATEWAY);
      }
      return { updated: true, node_id: id, config_overrides: reply.config_overrides ?? {} };
    }
    const overrides = node.config_overrides ?? {};
    for (const [key, value] of Object.entries(body)) {
      if (value === null) {
        delete overrides[key];
      } else {
        overrides[key] = value;
      }
    }
    // Persist to the DB (not just the in-memory node) so the change survives
    // an API restart — otherwise restoreNodes reverts it to the seeded config.
    this.brain.updateNodeConfig(id, overrides);
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
    return { updated: true, node_id: id, config_overrides: overrides };
  }

  // ─── Live wiring ────────────────────────────────────────────────────────
  // Subscriptions and publishes are editable post-spawn. Local nodes mutate
  // in-process via brain.{add,remove}Node{Subscription,Publish}; peer-owned
  // nodes route through brain.agents.<hub>.update_{subscriptions,publishes}.
  // The bus picks up the change live; DB persists so a restart on the owner
  // restores the new shape. Idempotent — re-adding an existing topic is a
  // no-op rather than an error.
  @Post(":id/subscriptions")
  async addSubscription(
    @Param("id") id: string,
    @Body() body: { topic: string; description?: string; inputSchema?: Record<string, unknown>; internal?: boolean; min_criticality?: number },
  ): Promise<{ added: boolean; existed: boolean; subscription_id?: string }> {
    if (!body.topic || !/^[a-zA-Z0-9._*>+-]+$/.test(body.topic)) {
      throw new HttpException("invalid topic", HttpStatus.BAD_REQUEST);
    }
    if (this.brain.instanceRegistry.get(id)) {
      try { return this.brain.addNodeSubscription(id, body.topic, body); }
      catch (e) { throw new HttpException(e instanceof Error ? e.message : String(e), HttpStatus.NOT_FOUND); }
    }
    return this.routeWiringToPeer<{ added: boolean; existed: boolean; subscription_id?: string }>(id, "update_subscriptions", { op: "add", node_id: id, ...body });
  }

  @Delete(":id/subscriptions/:topic")
  async removeSubscription(
    @Param("id") id: string,
    @Param("topic") topic: string,
  ): Promise<{ removed: boolean }> {
    const decoded = decodeURIComponent(topic);
    if (this.brain.instanceRegistry.get(id)) {
      try { return this.brain.removeNodeSubscription(id, decoded); }
      catch (e) { throw new HttpException(e instanceof Error ? e.message : String(e), HttpStatus.NOT_FOUND); }
    }
    return this.routeWiringToPeer<{ removed: boolean }>(id, "update_subscriptions", { op: "remove", node_id: id, topic: decoded });
  }

  @Post(":id/publishes")
  async addPublish(
    @Param("id") id: string,
    @Body() body: { topic: string },
  ): Promise<{ added: boolean; existed: boolean }> {
    if (!body.topic || !/^[a-zA-Z0-9._*>+-]+$/.test(body.topic)) {
      throw new HttpException("invalid topic", HttpStatus.BAD_REQUEST);
    }
    if (this.brain.instanceRegistry.get(id)) {
      try { return this.brain.addNodePublish(id, body.topic); }
      catch (e) { throw new HttpException(e instanceof Error ? e.message : String(e), HttpStatus.NOT_FOUND); }
    }
    return this.routeWiringToPeer<{ added: boolean; existed: boolean }>(id, "update_publishes", { op: "add", node_id: id, topic: body.topic });
  }

  @Delete(":id/publishes/:topic")
  async removePublish(
    @Param("id") id: string,
    @Param("topic") topic: string,
  ): Promise<{ removed: boolean }> {
    const decoded = decodeURIComponent(topic);
    if (this.brain.instanceRegistry.get(id)) {
      try { return this.brain.removeNodePublish(id, decoded); }
      catch (e) { throw new HttpException(e instanceof Error ? e.message : String(e), HttpStatus.NOT_FOUND); }
    }
    return this.routeWiringToPeer<{ removed: boolean }>(id, "update_publishes", { op: "remove", node_id: id, topic: decoded });
  }

  /** Resolve a node's owner hub from the merged view and dispatch a wiring
   *  request over NATS. Throws 404 if neither local nor peer-known.
   *  The owner-side handler wraps its return in `{ ok, ...rest, error? }`;
   *  on `ok: false` we surface the message as a 502. On success we return
   *  the rest (typed by the caller) — the `ok` field is consumed here. */
  private async routeWiringToPeer<T>(
    id: string, op: "update_subscriptions" | "update_publishes", payload: Record<string, unknown>,
  ): Promise<T> {
    const peer = this.brain.network.mergedNodes().find((n) => n.id === id);
    const hub = peer?.owner_hub?.hub_id;
    if (!hub) throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    const bus = this.brain.bus as { requestRemote?: NatsBusService["requestRemote"] };
    if (!bus.requestRemote) throw new HttpException("Bus does not support remote calls", HttpStatus.NOT_IMPLEMENTED);
    const reply = await bus.requestRemote<{ ok: boolean; error?: string } & T>(`brain.agents.${hub}.${op}`, payload);
    if (!reply.ok) throw new HttpException(reply.error ?? "remote wiring failed", HttpStatus.BAD_GATEWAY);
    return reply;
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
