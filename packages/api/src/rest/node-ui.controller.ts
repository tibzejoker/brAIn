import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  HttpException,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { BrainService } from "@brain/core";
import { BrokerTokenGuard } from "../auth/broker-token.guard";
import type { Message } from "@brain/sdk";
import * as path from "path";
import * as fs from "fs";

@Controller("nodes/:id/ui")
export class NodeUiController {
  constructor(private readonly brain: BrainService) {}

  // API routes MUST be declared before the wildcard file server

  @Post("send")
  @UseGuards(BrokerTokenGuard)
  send(
    @Param("id") id: string,
    @Body() body: {
      topic: string;
      content: string;
      criticality?: number;
      // Override the published `from`. Defaults to the node id (chat-style:
      // the node is the author, e.g. typed message). Set to a synthetic
      // origin like `system.ui` to drive the node's own subscriptions
      // from its UI — `from === id` triggers the bus anti-loop.
      from?: string;
      metadata?: Record<string, unknown>;
    },
  ): { message_id: string } {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) throw new HttpException("Node not found", HttpStatus.NOT_FOUND);

    const msg = this.brain.bus.publish({
      from: body.from ?? id,
      topic: body.topic,
      type: "text",
      criticality: body.criticality ?? 3,
      payload: { content: body.content },
      metadata: body.metadata,
    });

    return { message_id: msg.id };
  }

  @Get("messages")
  messages(@Param("id") id: string): Message[] {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) throw new HttpException("Node not found", HttpStatus.NOT_FOUND);

    // Get received messages from mailbox
    const received = this.brain.bus.readMessages(id, { mode: "all", limit: 50 });

    // Get sent messages from bus history (not in mailbox due to anti-loop)
    const sent = this.brain.bus.getMessageHistory({ from: id, last: 50 });

    // Merge, deduplicate, sort by timestamp
    const seen = new Set<string>();
    const all: Message[] = [];
    for (const msg of [...received, ...sent]) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        all.push(msg);
      }
    }
    all.sort((a, b) => a.timestamp - b.timestamp);

    return all.slice(-50);
  }

  // Wildcard file server — must be LAST
  @Get("*")
  serveUi(@Param("id") id: string, @Res() res: Response): void {
    const node = this.brain.instanceRegistry.get(id);
    if (!node) { res.status(404).json({ error: "Node not found" }); return; }

    const typeConfig = this.brain.typeRegistry.get(node.type);
    if (!typeConfig?.has_ui) { res.status(404).json({ error: "Node has no UI" }); return; }

    const typePath = this.brain.typeRegistry.getPath(node.type);
    if (!typePath) { res.status(404).json({ error: "Type path not found" }); return; }

    const uiDir = path.join(typePath, "ui");
    const reqPath = (res.req.params as Record<string, string>)[0] || "index.html";
    const filePath = path.join(uiDir, reqPath);

    if (!filePath.startsWith(uiDir)) { res.status(403).json({ error: "Forbidden" }); return; }
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }

    res.sendFile(filePath);
  }
}
