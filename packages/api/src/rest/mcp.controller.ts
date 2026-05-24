/**
 * Framework MCP HTTP endpoint. Exposes brAIn nodes as MCP tools
 * over Streamable HTTP, lazily and per-session.
 *
 * Routes:
 *   /mcp                    federated  — every node's described
 *                                        subscriptions become tools
 *                                        named `<nodeName>__<topic>`
 *   /nodes/:idOrName/mcp    per-node   — only that node's tools,
 *                                        named by topic. `idOrName`
 *                                        accepts the uuid OR the
 *                                        node's name (if unique).
 *                                        Ambiguous name → 400 with
 *                                        the candidate ids.
 *
 * Session model: one HTTP listener (NestJS), one Server+Transport
 * pair PER MCP client session. Sessions live in per-route pools so
 * `/mcp` and `/nodes/X/mcp` don't share a session table. The
 * Server+Transport pair is created on the FIRST request that has no
 * Mcp-Session-Id; subsequent requests carrying that id reuse it.
 *
 * Tool calls go through `BrainService.mcpBridge` — publish on the
 * bus topic with `reply_to` = `mcp.bridge.reply.<reqId>`, await
 * resolution, return the result as MCP text content.
 */
import {
  Controller, All, Param, Req, Res, HttpException, HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  BrainService, federatedTools, toolsForNode, resolveNode,
  type MCPTool,
} from "@brain/core";

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

@Controller()
export class MCPController {
  /** Per-route session pools (route key → sessions by sid). */
  private readonly pools = new Map<string, Map<string, SessionEntry>>();
  /** Pending session entries waiting for SDK to mint a sessionId. */
  private readonly pendingByRoute = new Map<string, SessionEntry>();

  constructor(private readonly brain: BrainService) {}

  // === Federated route ===

  @All("mcp")
  async federated(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle(req, res, "federated", () => federatedTools(this.brain.getNetworkSnapshot()));
  }

  // === Per-node route ===

  @All("nodes/:idOrName/mcp")
  async perNode(
    @Param("idOrName") idOrName: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const all = this.brain.getNetworkSnapshot();
    const lookup = resolveNode(all, idOrName);
    if (lookup.kind === "not-found") {
      throw new HttpException({ error: `node '${idOrName}' not found` }, HttpStatus.NOT_FOUND);
    }
    if (lookup.kind === "ambiguous") {
      throw new HttpException({
        error: `name '${idOrName}' is ambiguous`,
        candidates: lookup.candidates.map((n) => ({ id: n.id, name: n.name, type: n.type })),
        hint: "use the node id (first column) instead of the name",
      }, HttpStatus.BAD_REQUEST);
    }
    const node = lookup.node;
    await this.handle(req, res, `node:${node.id}`, () => toolsForNode(node));
  }

  // === Internal ===

  private async handle(
    req: Request,
    res: Response,
    routeKey: string,
    buildTools: () => MCPTool[],
  ): Promise<void> {
    let pool = this.pools.get(routeKey);
    if (!pool) { pool = new Map(); this.pools.set(routeKey, pool); }

    const sidHeader = req.header("mcp-session-id");
    let entry: SessionEntry | undefined = sidHeader ? pool.get(sidHeader) : undefined;

    if (!entry) {
      entry = await this.createSession(routeKey, buildTools);
    }
    entry.lastActivity = Date.now();

    // Express buffers the JSON body for us when content-type is set;
    // but the StreamableHTTP transport expects `parsedBody` only on
    // POSTs that carry it. Pass req.body through directly — Nest
    // decoded it via the global body parser.
    await entry.transport.handleRequest(req, res, req.body as unknown);
  }

  private async createSession(
    routeKey: string,
    buildTools: () => MCPTool[],
  ): Promise<SessionEntry> {
    const tools = buildTools();
    const toolByName = new Map(tools.map((t) => [t.name, t] as const));

    const server = new Server(
      { name: `brAIn:${routeKey}`, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // MCP spec field — present only when the underlying subscription
        // declared itself RPC-shaped via `outputSchema` on its config.
        // External clients use it to type-check the reply they expect.
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = toolByName.get(req.params.name);
      if (!tool) throw new Error(`Unknown tool '${req.params.name}'`);
      const args = req.params.arguments ?? {};
      const raw = await this.brain.mcpBridge.call(tool.topic, args);
      return { content: [{ type: "text" as const, text: raw }] };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        const placeholder = this.pendingByRoute.get(routeKey);
        if (!placeholder) return;
        this.pendingByRoute.delete(routeKey);
        placeholder.lastActivity = Date.now();
        const pool = this.pools.get(routeKey) ?? new Map<string, SessionEntry>();
        pool.set(sid, placeholder);
        this.pools.set(routeKey, pool);
      },
      onsessionclosed: (sid) => {
        const pool = this.pools.get(routeKey);
        const e = pool?.get(sid);
        if (!e || !pool) return;
        pool.delete(sid);
        void e.server.close().catch(() => { /* ignore */ });
      },
    });
    const entry: SessionEntry = { server, transport, lastActivity: Date.now() };
    this.pendingByRoute.set(routeKey, entry);
    await server.connect(transport);
    return entry;
  }
}
