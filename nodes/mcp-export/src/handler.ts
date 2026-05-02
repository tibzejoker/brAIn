/**
 * mcp-export — exposes brAIn nodes as an MCP server over HTTP.
 *
 * Mirror of mcp-server: where mcp-server consumes external MCPs and
 * surfaces their tools as bus topics, mcp-export does the inverse —
 * spins up an MCP HTTP endpoint where each declared tool maps to a
 * bus topic. External MCP clients (Claude Code, Cursor, …) can
 * connect to it like any other MCP server.
 *
 * config_overrides shape:
 *
 *   {
 *     "port": 4000,
 *     "tools": [
 *       {
 *         "name": "ask_brain",
 *         "description": "Ask the central brAIn node a question",
 *         "topic": "brain.ask",
 *         "inputSchema": {
 *           "type": "object",
 *           "properties": { "question": { "type": "string" } },
 *           "required": ["question"]
 *         },
 *         "timeoutMs": 30000
 *       }
 *     ]
 *   }
 *
 * Request flow:
 *   1. Client → tools/call → HTTP server hits CallToolRequestSchema handler
 *   2. Handler generates reqId, publishes on `binding.topic` with
 *      reply_to = `mcp.export.reply.<reqId>`
 *   3. Target node receives, processes, replies on the reply topic
 *   4. mcp-export's handler tick drains the reply, resolves the
 *      promise, MCP client gets the result
 *
 * Spawn multiple mcp-export instances on different ports if you want
 * different curated tool sets exposed to different clients.
 */
import type {
  NodeHandler, NodeContext, NodeInfo, NodeOnSpawn, NodeTeardown, TextPayload,
} from "@brain/sdk";
import { BrainService } from "@brain/core";
import { type RunningServer, type ToolBinding, deliverReply, startServer, stopServer } from "./server";

interface ExportRuntime {
  server: RunningServer | null;
  /** Last-applied config hash so we restart only when it actually changed. */
  configHash: string;
  /** True when the next handler tick should reconcile the server. */
  reloadDirty: boolean;
}

const runtimes = new Map<string, ExportRuntime>();

function getRt(nodeId: string): ExportRuntime {
  let rt = runtimes.get(nodeId);
  if (!rt) {
    rt = { server: null, configHash: "", reloadDirty: true };
    runtimes.set(nodeId, rt);
  }
  return rt;
}

interface ParsedConfig {
  port: number;
  tools: ToolBinding[];
}

function parseConfig(overrides: Record<string, unknown>, log: NodeContext["log"]): ParsedConfig | null {
  const port = typeof overrides.port === "number" ? overrides.port : 4000;
  const rawTools = overrides.tools;
  if (!Array.isArray(rawTools)) {
    if (rawTools !== undefined) log("warn", "config_overrides.tools must be an array");
    return { port, tools: [] };
  }
  const tools: ToolBinding[] = [];
  for (const raw of rawTools) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.topic !== "string") {
      log("warn", "tool entry missing name or topic; skipped");
      continue;
    }
    tools.push({
      name: r.name,
      description: typeof r.description === "string" ? r.description : r.name,
      topic: r.topic,
      inputSchema: typeof r.inputSchema === "object" && r.inputSchema !== null
        ? r.inputSchema as Record<string, unknown>
        : { type: "object" },
      timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : undefined,
    });
  }
  return { port, tools };
}

function hashConfig(c: ParsedConfig): string {
  return JSON.stringify({
    port: c.port,
    tools: c.tools.map((t) => ({ ...t })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}

async function reload(ctx: NodeContext, rt: ExportRuntime): Promise<void> {
  const cfg = parseConfig(ctx.node.config_overrides ?? {}, ctx.log);
  if (!cfg) return;
  const nextHash = hashConfig(cfg);
  if (rt.server && rt.configHash === nextHash) return;
  if (rt.server) {
    ctx.log("info", `stopping server on :${rt.server.port}`);
    await stopServer(rt.server);
    rt.server = null;
  }
  if (cfg.tools.length === 0) {
    ctx.log("info", "no tools configured — server idle");
    rt.configHash = nextHash;
    return;
  }
  const brain = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!brain) { ctx.log("error", "BrainService unavailable — cannot start server"); return; }
  const selfId = ctx.node.id;
  try {
    rt.server = await startServer(cfg.port, cfg.tools, (topic, payload, replyTo) => {
      brain.bus.publish({
        from: selfId, topic,
        type: "text", criticality: 1,
        payload: { content: payload },
        reply_to: replyTo,
      });
    }, selfId);
    rt.configHash = nextHash;
    ctx.log("info", `MCP server up on :${cfg.port} with ${cfg.tools.length} tool(s)`);
  } catch (err) {
    ctx.log("error", `failed to start server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// === Lifecycle ===

export const onSpawn: NodeOnSpawn = (info: NodeInfo): void => {
  const rt = getRt(info.id);
  rt.reloadDirty = true;
  // Self-trigger so the handler fires once and starts the HTTP
  // server even before any external message lands. Without this the
  // node would sit dormant until something publishes mcp.export.reload.
  const brain = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!brain) return;
  brain.bus.publish({
    from: "system.lifecycle",
    topic: "mcp.export.reload",
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ node_id: info.id }) },
    metadata: { node_id: info.id },
  });
};

export const teardown: NodeTeardown = async (info: NodeInfo): Promise<void> => {
  const rt = runtimes.get(info.id);
  if (!rt) return;
  if (rt.server) await stopServer(rt.server);
  runtimes.delete(info.id);
};

export const handler: NodeHandler = async (ctx: NodeContext): Promise<void> => {
  const rt = getRt(ctx.node.id);

  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.export.reload") { rt.reloadDirty = true; continue; }
    const m = /^mcp\.export\.reply\.(.+)$/.exec(msg.topic);
    if (m && rt.server) {
      const reqId = m[1];
      deliverReply(rt.server, reqId, (msg.payload as TextPayload).content);
    }
  }

  if (rt.reloadDirty) {
    rt.reloadDirty = false;
    await reload(ctx, rt);
  }
};
