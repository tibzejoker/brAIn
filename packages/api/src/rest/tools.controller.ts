import {
  Controller, Get, Param, Query, HttpException, HttpStatus,
} from "@nestjs/common";
import { BrainService, toolDescriptorsForNode } from "@brain/core";
import type { NodeInfo, ToolDescriptor } from "@brain/sdk";

/**
 * REST surface for the network-wide tool catalog — the HTTP face of
 * the same data `ctx.tools.list()` exposes to in-process nodes.
 *
 * Both this controller and the in-process facade delegate to
 * `toolDescriptorsForNode` so the two surfaces always stay in sync,
 * including the wildcard-port resolution (an `alerts.*` binding
 * surfaces as `alerts.<port_name>` here — a subject MCP clients can
 * actually publish on).
 *
 * GET /tools                 — every input port on the network
 * GET /tools?node_id=:id     — same, filtered to one node
 * GET /tools/:node_id        — every input port for a single node
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

function collect(nodes: NodeInfo[]): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const node of nodes) for (const d of toolDescriptorsForNode(node)) out.push(d);
  return out;
}
