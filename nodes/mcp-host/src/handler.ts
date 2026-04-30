/**
 * mcp-host — bridges external MCP servers onto the brAIn bus.
 *
 * Each server is configured by **transport**:
 *
 *   stdio  — for local subprocess servers (filesystem, git, …)
 *     { name: "fs", transport: "stdio",
 *       command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
 *
 *   http   — modern Streamable HTTP, current standard for remote MCP
 *     { name: "linear", transport: "http",
 *       url: "https://mcp.linear.app/mcp",
 *       headers: { authorization: "Bearer <token>" } }
 *
 *   sse    — legacy HTTP/SSE servers (still common as of 2026)
 *     { name: "exa", transport: "sse", url: "https://mcp.exa.ai/sse" }
 *
 *   ws     — WebSocket servers
 *     { name: "ws-srv", transport: "ws", url: "wss://example.com/mcp" }
 *
 * On spawn the node connects to every server, discovers its tools,
 * and listens on:
 *   - `mcp.call`  → { server?, tool, arguments? } → `mcp.result`
 *   - `mcp.tools.list` → `mcp.tools.available`
 * Aborts in flight when the runner preempts the iteration.
 */
import type { NodeHandler, NodeOnSpawn, NodeTeardown, TextPayload } from "@brain/sdk";
import { logger } from "@brain/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";

interface StdioSpec {
  name: string;
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpSpec {
  name: string;
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

interface SseSpec {
  name: string;
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

interface WsSpec {
  name: string;
  transport: "ws";
  url: string;
}

type ServerSpec = StdioSpec | HttpSpec | SseSpec | WsSpec;

type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport
  | WebSocketClientTransport;

interface ToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  spec: ServerSpec;
  client: Client;
  transport: AnyTransport;
  tools: ToolDescriptor[];
}

interface MCPCallRequest {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

const servers = new Map<string, ConnectedServer>();

function isValidSpec(s: unknown): s is ServerSpec {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  if (typeof r.name !== "string") return false;
  const t = r.transport;
  // stdio (default) needs `command`; http/sse/ws need `url`.
  if (t === undefined || t === "stdio") return typeof r.command === "string";
  if (t === "http" || t === "sse" || t === "ws") return typeof r.url === "string";
  return false;
}

function getServers(overrides: Record<string, unknown>): ServerSpec[] {
  const raw = overrides.servers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidSpec);
}

function buildTransport(spec: ServerSpec): AnyTransport {
  const t = spec.transport ?? "stdio";
  switch (t) {
    case "stdio":
      return new StdioClientTransport({
        command: (spec as StdioSpec).command,
        args: (spec as StdioSpec).args ?? [],
        env: (spec as StdioSpec).env,
      });
    case "http": {
      const s = spec as HttpSpec;
      return new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: s.headers ? { headers: s.headers } : undefined,
      });
    }
    case "sse": {
      const s = spec as SseSpec;
      return new SSEClientTransport(new URL(s.url), {
        requestInit: s.headers ? { headers: s.headers } : undefined,
      });
    }
    case "ws":
      return new WebSocketClientTransport(new URL((spec as WsSpec).url));
  }
}

async function connectServer(spec: ServerSpec): Promise<ConnectedServer> {
  const transport = buildTransport(spec);
  const client = new Client(
    { name: `brAIn-mcp-host:${spec.name}`, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const list = await client.listTools();
  const tools: ToolDescriptor[] = list.tools.map((t) => ({
    server: spec.name,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
  return { spec, client, transport, tools };
}

function flatToolList(): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const s of servers.values()) out.push(...s.tools);
  return out;
}

function pickServer(req: MCPCallRequest): ConnectedServer | null {
  if (req.server) return servers.get(req.server) ?? null;
  // No server hint → find the first server that knows the tool.
  for (const s of servers.values()) {
    if (s.tools.some((t) => t.name === req.tool)) return s;
  }
  return null;
}

export const onSpawn: NodeOnSpawn = async (info) => {
  const overrides = info.config_overrides ?? {};
  const specs = getServers(overrides);
  for (const spec of specs) {
    try {
      const conn = await connectServer(spec);
      servers.set(spec.name, conn);
    } catch (err) {
      // Connect failures are expected in dev (server binaries not
      // installed). Log via the brain logger and keep going.
      logger.error({ err, server: spec.name }, "mcp-host: failed to connect");
    }
  }
};

export const teardown: NodeTeardown = async () => {
  for (const s of servers.values()) {
    try { await s.client.close(); } catch { /* ignore */ }
    try { await s.transport.close(); } catch { /* ignore */ }
  }
  servers.clear();
};

export const handler: NodeHandler = async (ctx) => {
  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.tools.list") {
      const tools = flatToolList();
      ctx.publish("mcp.tools.available", {
        type: "text",
        criticality: 1,
        payload: { content: JSON.stringify({ tools }) },
        metadata: { tools },
      });
      continue;
    }

    if (msg.topic !== "mcp.call") continue;

    let req: MCPCallRequest;
    try {
      const raw = (msg.payload as TextPayload).content;
      req = JSON.parse(raw) as MCPCallRequest;
    } catch {
      ctx.respond(JSON.stringify({ error: "mcp.call payload must be JSON {server?, tool, arguments?}" }));
      continue;
    }

    if (!req.tool) {
      ctx.respond(JSON.stringify({ error: "mcp.call requires `tool`" }));
      continue;
    }

    const conn = pickServer(req);
    if (!conn) {
      ctx.respond(JSON.stringify({
        error: `no MCP server knows tool '${req.tool}'`,
        servers: Array.from(servers.keys()),
      }));
      continue;
    }

    try {
      ctx.log("info", `mcp.call → ${conn.spec.name}::${req.tool}`);
      const result = await conn.client.callTool(
        { name: req.tool, arguments: req.arguments ?? {} },
        undefined,
        { signal: ctx.signal },
      );
      ctx.respond(JSON.stringify(result), { server: conn.spec.name, tool: req.tool });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.respond(JSON.stringify({ error: errMsg, server: conn.spec.name, tool: req.tool }));
    }
  }
};
