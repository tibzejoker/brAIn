/**
 * Lazy multi-session MCP HTTP server wired to the brAIn bus.
 *
 * Pattern: ONE shared HTTP listener + one Server+Transport pair PER
 * connected MCP client (keyed by session id). The first call without
 * a `Mcp-Session-Id` mints a new pair; subsequent calls with the
 * same id reuse it. We never pre-mount a transport — sessions exist
 * only because clients asked for them.
 *
 * Tool catalog is shared across sessions: each new Server is
 * configured with the same `tools` list at creation time. Calls
 * resolve through one process-wide `pending` Map keyed by request
 * id, since the bus reply is delivered to the (single) mcp-export
 * node regardless of which session originated the call.
 */
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "@brain/core";

export interface ToolBinding {
  name: string;
  description: string;
  topic: string;
  inputSchema: Record<string, unknown>;
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

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export interface RunningServer {
  port: number;
  bindings: Map<string, ToolBinding>;
  pending: Map<string, PendingReply>;
  sessions: Map<string, SessionEntry>;
  http: http.Server;
  selfNodeId: string;
  publish: PublishFn;
}

export function deliverReply(rs: RunningServer, reqId: string, raw: string): void {
  const entry = rs.pending.get(reqId);
  if (!entry) return;
  rs.pending.delete(reqId);
  clearTimeout(entry.timer);
  entry.resolve(raw);
}

function createSession(rs: RunningServer): SessionEntry {
  const server = new Server(
    { name: `brAIn-export:${rs.selfNodeId.slice(0, 8)}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
    tools: [...rs.bindings.values()].map((b) => ({
      name: b.name, description: b.description, inputSchema: b.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const binding = rs.bindings.get(req.params.name);
    if (!binding) throw new Error(`Unknown tool '${req.params.name}'`);
    const reqId = randomUUID();
    const replyTopic = `mcp.export.reply.${reqId}`;
    const args = req.params.arguments ?? {};
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        rs.pending.delete(reqId);
        reject(new Error(`tool '${binding.name}' timed out (no reply on ${replyTopic})`));
      }, binding.timeoutMs ?? 30_000);
      rs.pending.set(reqId, { resolve, reject, timer });
      try { rs.publish(binding.topic, JSON.stringify(args), replyTopic); }
      catch (err) {
        rs.pending.delete(reqId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { content: [{ type: "text" as const, text: raw }] };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      // Move the freshly-minted entry into the keyed map. We register
      // it under `__pending__` first because the SDK only tells us
      // the id after init completes.
      const placeholder = rs.sessions.get("__pending__");
      if (!placeholder) return;
      rs.sessions.delete("__pending__");
      placeholder.lastActivity = Date.now();
      rs.sessions.set(sid, placeholder);
      logger.info({ port: rs.port, sid }, "mcp-export: new session");
    },
    onsessionclosed: (sid) => {
      const entry = rs.sessions.get(sid);
      if (!entry) return;
      rs.sessions.delete(sid);
      void entry.server.close().catch(() => { /* ignore */ });
      logger.info({ port: rs.port, sid }, "mcp-export: session closed");
    },
  });
  return { server, transport, lastActivity: Date.now() };
}

async function handleRequest(rs: RunningServer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) as unknown : undefined;

  const sid = req.headers["mcp-session-id"];
  const sessionId = typeof sid === "string" ? sid : undefined;

  let entry = sessionId ? rs.sessions.get(sessionId) : undefined;
  if (!entry) {
    entry = createSession(rs);
    // Park under __pending__ so onsessioninitialized can rename it.
    rs.sessions.set("__pending__", entry);
    await entry.server.connect(entry.transport);
  }
  entry.lastActivity = Date.now();
  await entry.transport.handleRequest(req, res, parsed);
}

export function startServer(
  port: number,
  bindings: ToolBinding[],
  publish: PublishFn,
  selfNodeId: string,
): Promise<RunningServer> {
  const bindingMap = new Map<string, ToolBinding>();
  for (const b of bindings) bindingMap.set(b.name, b);
  const rs: RunningServer = {
    port,
    bindings: bindingMap,
    pending: new Map(),
    sessions: new Map(),
    http: http.createServer(),
    selfNodeId,
    publish,
  };
  rs.http.on("request", (req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = req.url ?? "/";
        if (!url.startsWith("/mcp")) {
          res.writeHead(404).end("not found");
          return;
        }
        await handleRequest(rs, req, res);
      } catch (err) {
        logger.error({ err }, "mcp-export: HTTP handler crashed");
        if (!res.headersSent) res.writeHead(500).end("internal error");
      }
    })();
  });
  return new Promise((resolve) => {
    rs.http.listen(port, () => {
      logger.info({ port, tools: bindings.length }, "mcp-export: HTTP server listening (no sessions yet)");
      resolve(rs);
    });
  });
}

export async function stopServer(rs: RunningServer): Promise<void> {
  for (const p of rs.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("server shutdown"));
  }
  rs.pending.clear();
  for (const entry of rs.sessions.values()) {
    try { await entry.transport.close(); } catch { /* ignore */ }
    try { await entry.server.close(); } catch { /* ignore */ }
  }
  rs.sessions.clear();
  await new Promise<void>((resolve) => rs.http.close(() => resolve()));
}
