/**
 * Wraps the MCP SDK's Server + StreamableHTTPServerTransport in a
 * thin shell wired to the brAIn bus.
 *
 * The server exposes one tool per entry in `tools` (ToolBinding).
 * `tools/list` returns the static catalog; `tools/call` translates
 * the call into a bus publish on the binding's topic, with
 * `reply_to` set to a unique `mcp.export.reply.<reqId>` topic. The
 * incoming reply is matched by reqId in the handler tick which
 * resolves the promise the call is awaiting.
 */
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "@brain/core";

export interface ToolBinding {
  /** Tool name as advertised to MCP clients. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Bus topic the request is published on. The target node must reply via reply_to. */
  topic: string;
  /** JSON Schema for the tool's arguments. Forwarded verbatim to MCP clients. */
  inputSchema: Record<string, unknown>;
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface PublishFn {
  (topic: string, payload: string, replyTo: string): void;
}

interface PendingReply {
  resolve: (raw: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RunningServer {
  port: number;
  bindings: Map<string, ToolBinding>;
  pending: Map<string, PendingReply>;
  http: http.Server;
  mcp: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * Resolves the reply for a given reqId, if pending. Called by the
 * handler tick when a `mcp.export.reply.<reqId>` message lands.
 */
export function deliverReply(rs: RunningServer, reqId: string, raw: string): void {
  const entry = rs.pending.get(reqId);
  if (!entry) return;
  rs.pending.delete(reqId);
  clearTimeout(entry.timer);
  entry.resolve(raw);
}

export async function startServer(
  port: number,
  bindings: ToolBinding[],
  publish: PublishFn,
  selfNodeId: string,
): Promise<RunningServer> {
  const bindingMap = new Map<string, ToolBinding>();
  for (const b of bindings) bindingMap.set(b.name, b);
  const pending = new Map<string, PendingReply>();

  const mcp = new Server(
    { name: `brAIn-export:${selfNodeId.slice(0, 8)}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
    tools: [...bindingMap.values()].map((b) => ({
      name: b.name, description: b.description, inputSchema: b.inputSchema,
    })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const binding = bindingMap.get(req.params.name);
    if (!binding) throw new Error(`Unknown tool '${req.params.name}'`);
    const reqId = randomUUID();
    const replyTopic = `mcp.export.reply.${reqId}`;
    const args = req.params.arguments ?? {};
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`tool '${binding.name}' timed out (no reply on ${replyTopic})`));
      }, binding.timeoutMs ?? 30_000);
      pending.set(reqId, { resolve, reject, timer });
      try {
        publish(binding.topic, JSON.stringify(args), replyTopic);
      } catch (err) {
        pending.delete(reqId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { content: [{ type: "text" as const, text: raw }] };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const httpServer = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = req.url ?? "/";
        if (!url.startsWith("/mcp")) {
          res.writeHead(404).end("not found");
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (err) {
        logger.error({ err }, "mcp-export: HTTP handler crashed");
        if (!res.headersSent) res.writeHead(500).end("internal error");
      }
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  logger.info({ port, tools: bindings.length }, "mcp-export: HTTP server listening");

  return { port, bindings: bindingMap, pending, http: httpServer, mcp, transport };
}

export async function stopServer(rs: RunningServer): Promise<void> {
  for (const p of rs.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("server shutdown"));
  }
  rs.pending.clear();
  try { await rs.transport.close(); } catch { /* ignore */ }
  try { await rs.mcp.close(); } catch { /* ignore */ }
  await new Promise<void>((resolve) => rs.http.close(() => resolve()));
}
