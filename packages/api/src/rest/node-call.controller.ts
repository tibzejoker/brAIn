import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Res,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { BrainService, NatsBusService, resolveHubId, getDb } from "@brain/core";
import type { Message } from "@brain/sdk";

/**
 * Node-centric HTTP namespace — **single pattern, always over NATS**.
 *
 *   POST /node/:nodeId/<topic>      → RPC: publish <topic> on the bus for the
 *                                     handler that lives on this node's hub.
 *                                     Body becomes the message payload.
 *   GET  /node/:nodeId/messages     → poll this node's mailbox (recent
 *                                     traffic — incoming + sent).
 *   GET  /node/:nodeId/ui/<path>    → serve a static UI file from the node's
 *                                     `ui/` directory.
 *
 * Whether the node lives here or on a peer hub, every route goes through
 * `brain.agents.<ownerHub>.*` over NATS — the dashboard is always same-origin
 * and never reaches another machine's HTTP. Local calls loop through the bus
 * too, so there is exactly one code path to reason about.
 */
@Controller("node")
export class NodeCallController {
  constructor(private readonly brain: BrainService) {}

  @Get(":nodeId/messages")
  async messages(@Param("nodeId") nodeId: string): Promise<Message[]> {
    const ownerHub = ownerHubOf(this.brain, nodeId);
    const requestRemote = requireRequestRemote(this.brain);
    return requestRemote<Message[]>(
      `brain.agents.${ownerHub}.ui_messages`,
      { nodeId },
    );
  }

  @Get(":nodeId/ui/*")
  async serveUi(@Param("nodeId") nodeId: string, @Res() res: Response): Promise<void> {
    const reqPath = (res.req.params as Record<string, string>)[0] || "index.html";
    let ownerHub: string;
    try {
      ownerHub = ownerHubOf(this.brain, nodeId);
    } catch {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    try {
      const requestRemote = requireRequestRemote(this.brain);
      const reply = await requestRemote<{ status: number; contentType?: string; base64?: string; error?: string }>(
        `brain.agents.${ownerHub}.ui_file`,
        { nodeId, subpath: reqPath },
        8000, // ui files can be tens of KB; base64 + LAN hop, 8s is comfortable
      );
      if (reply.status !== 200 || !reply.base64) {
        res.status(reply.status || 502).json({ error: reply.error ?? "ui_file failed" });
        return;
      }
      res.set("Content-Type", reply.contentType ?? "application/octet-stream");
      res.send(Buffer.from(reply.base64, "base64"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException(`ui_file: ${msg}`, HttpStatus.BAD_GATEWAY);
    }
  }

  @Post(":nodeId/*")
  async call(
    @Param("nodeId") nodeId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ message_id: string }> {
    const topic = (req.params as Record<string, string>)[0] ?? "";
    if (!topic) throw new HttpException("topic missing in path", HttpStatus.BAD_REQUEST);

    const ownerHub = ownerHubOf(this.brain, nodeId);
    const requestRemote = requireRequestRemote(this.brain);
    return requestRemote<{ message_id: string }>(
      `brain.agents.${ownerHub}.node_call`,
      { nodeId, topic, body },
    );
  }
}

export function ownerHubOf(brain: BrainService, nodeId: string): string {
  if (brain.instanceRegistry.get(nodeId)) return resolveHubId(getDb());
  const peer = brain.network.mergedNodes().find((n) => n.id === nodeId);
  if (peer?.owner_hub?.hub_id) return peer.owner_hub.hub_id;
  throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
}

export function requireRequestRemote(brain: BrainService): NatsBusService["requestRemote"] {
  const bus = brain.bus as { requestRemote?: NatsBusService["requestRemote"] };
  if (!bus.requestRemote) {
    throw new HttpException("Bus does not support remote calls", HttpStatus.NOT_IMPLEMENTED);
  }
  return bus.requestRemote.bind(bus as unknown as NatsBusService);
}
