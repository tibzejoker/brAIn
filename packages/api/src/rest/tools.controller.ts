import {
  Controller, Get, Param, Query, HttpException, HttpStatus,
} from "@nestjs/common";
import { BrainService } from "@brain/core";
import type { NodeInfo, ToolDescriptor } from "@brain/sdk";

/**
 * REST surface for the network-wide tool catalog — the HTTP face of
 * the same data `ctx.tools.list()` exposes to in-process nodes.
 *
 * Internal subscriptions (`internal: true`) are filtered out; only
 * public subs that declare an `inputSchema` show up.
 *
 * GET /tools                 — every public tool on the network
 * GET /tools?node_id=:id     — same, filtered to one node
 * GET /tools/:node_id        — every public tool for a single node
 *                              (404 if that node doesn't exist)
 */
@Controller("tools")
export class ToolsController {
  constructor(private readonly brain: BrainService) {}

  @Get()
  list(@Query("node_id") nodeId?: string): ToolDescriptor[] {
    if (nodeId) {
      const node = this.brain.instanceRegistry.get(nodeId);
      if (!node) return [];
      return collect([node]);
    }
    return collect(this.brain.instanceRegistry.list());
  }

  @Get(":node_id")
  listForNode(@Param("node_id") nodeId: string): ToolDescriptor[] {
    const node = this.brain.instanceRegistry.get(nodeId);
    if (!node) throw new HttpException("Node not found", HttpStatus.NOT_FOUND);
    return collect([node]);
  }
}

/** Iterate nodes → public subs → `ToolDescriptor`. Mirrors the logic
 *  in `buildToolsFacade` (packages/core/src/runner/context-builder.ts)
 *  so the in-process and HTTP catalogs stay in sync. */
function collect(nodes: NodeInfo[]): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const node of nodes) {
    for (const sub of node.subscriptions) {
      if (sub.internal === true) continue;
      out.push({
        node_id: node.id,
        node_type: node.type,
        node_name: node.name,
        topic: sub.topic,
        description: sub.description,
        inputSchema: sub.inputSchema,
      });
    }
  }
  return out;
}
