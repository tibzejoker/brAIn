/**
 * mcp-host — bridges external MCP servers onto the brAIn bus.
 *
 * Configuration uses the `mcpServers` shape that's now the de-facto
 * standard across Claude Desktop / Claude Code / Cursor / Cline / etc.
 * Top-level key is an object map (server name → spec). Each spec
 * auto-discriminates from its fields:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {                        // stdio (subprocess)
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *         "env": { "LOG_LEVEL": "info" }
 *       },
 *       "linear": {                            // Streamable HTTP (current standard)
 *         "url": "https://mcp.linear.app/mcp",
 *         "headers": { "Authorization": "Bearer ${env:LINEAR_API_KEY}" }
 *       },
 *       "exa-legacy": {                        // SSE (legacy)
 *         "url": "https://mcp.exa.ai/sse",
 *         "type": "sse"
 *       }
 *     }
 *   }
 *
 * Discriminator: presence of `command` → stdio, presence of `url` →
 * remote (default Streamable HTTP, override via `type: "sse"` / "ws").
 *
 * `${env:VAR}` interpolation in headers / args / env keeps secrets
 * out of the persisted config.
 *
 * The legacy `servers: [{name, transport, …}]` array form is still
 * accepted for back-compat with the first iteration of this node.
 *
 * Bus topics:
 *   mcp.call           { server?, tool, arguments? } → mcp.result
 *   mcp.tools.list                                    → mcp.tools.available
 *   mcp.host.reload                                   diff config_overrides
 *                                                     and reconnect changed
 *
 * Multiple mcp-host instances in the same process keep independent
 * connection state — each instance is keyed by its node id.
 */
import type {
  NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown, TextPayload,
} from "@brain/sdk";
import { logger } from "@brain/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";

interface NormalizedSpec {
  /** Stable name used to address the server in `mcp.call`. */
  name: string;
  /** "stdio" | "http" | "sse" | "ws". Auto-derived if not set. */
  transport: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

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
  spec: NormalizedSpec;
  client: Client;
  transport: AnyTransport;
  tools: ToolDescriptor[];
  connectedAt: number;
  /** Stable hash of the spec used to detect "needs reconnect". */
  specHash: string;
  status: "connected";
  error?: undefined;
}

interface FailedServer {
  spec: NormalizedSpec;
  status: "error";
  error: string;
  specHash: string;
}

type ServerEntry = ConnectedServer | FailedServer;

/** Per-node-instance state. */
interface Instance {
  servers: Map<string, ServerEntry>;
}

interface MCPCallRequest {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

// Module-level Map keyed by node id so multiple mcp-host instances in
// the same process keep independent connections (and clean teardowns).
const instances = new Map<string, Instance>();

function getInstance(nodeId: string): Instance {
  let i = instances.get(nodeId);
  if (!i) { i = { servers: new Map() }; instances.set(nodeId, i); }
  return i;
}

// === Config parsing ===

/**
 * Resolve `${env:VAR}` references in a string. Returns the original if
 * no match; replaces with `process.env[VAR]` (or empty string when
 * unset) so a config can ship without leaking secrets.
 */
function expandEnv(input: string): string {
  return input.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => process.env[v] ?? "");
}

function expandRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandEnv(v);
  return out;
}

function expandArgs(args?: string[]): string[] | undefined {
  return args?.map((a) => expandEnv(a));
}

function normalizeSpec(name: string, raw: Record<string, unknown>): NormalizedSpec | null {
  const cmd = typeof raw.command === "string" ? raw.command : undefined;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const explicitTransport = typeof raw.transport === "string" ? raw.transport : typeof raw.type === "string" ? raw.type : undefined;

  let transport: NormalizedSpec["transport"];
  if (explicitTransport === "stdio") transport = "stdio";
  else if (explicitTransport === "sse") transport = "sse";
  else if (explicitTransport === "ws" || explicitTransport === "websocket") transport = "ws";
  else if (explicitTransport === "http" || explicitTransport === "streamable-http") transport = "http";
  else if (cmd) transport = "stdio";
  else if (url) transport = "http";
  else return null;

  if (transport === "stdio" && !cmd) return null;
  if (transport !== "stdio" && !url) return null;

  return {
    name,
    transport,
    command: cmd,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : undefined,
    env: typeof raw.env === "object" && raw.env !== null ? raw.env as Record<string, string> : undefined,
    url,
    headers: typeof raw.headers === "object" && raw.headers !== null ? raw.headers as Record<string, string> : undefined,
  };
}

/**
 * Read `config_overrides` and produce the canonical list of specs.
 * Accepts both the standard `mcpServers: { name: {…} }` map AND the
 * legacy `servers: [{name, …}]` array.
 */
function parseSpecs(overrides: Record<string, unknown>): NormalizedSpec[] {
  const out: NormalizedSpec[] = [];
  const map = overrides.mcpServers;
  if (typeof map === "object" && map !== null && !Array.isArray(map)) {
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const spec = normalizeSpec(name, raw as Record<string, unknown>);
      if (spec) out.push(spec);
    }
  }
  const arr = overrides.servers;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== "string") continue;
      const spec = normalizeSpec(r.name, r);
      if (spec) out.push(spec);
    }
  }
  return out;
}

/** Stable JSON hash of a spec. Used to detect "config changed → reconnect". */
function hashSpec(spec: NormalizedSpec): string {
  // Sort keys for stable hashing.
  return JSON.stringify(spec, Object.keys(spec).sort());
}

// === Connection ===

function buildTransport(spec: NormalizedSpec): AnyTransport {
  switch (spec.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: spec.command ?? "",
        args: expandArgs(spec.args) ?? [],
        env: expandRecord(spec.env),
      });
    case "http": {
      const headers = expandRecord(spec.headers);
      return new StreamableHTTPClientTransport(new URL(spec.url ?? ""), {
        requestInit: headers ? { headers } : undefined,
      });
    }
    case "sse": {
      const headers = expandRecord(spec.headers);
      return new SSEClientTransport(new URL(spec.url ?? ""), {
        requestInit: headers ? { headers } : undefined,
      });
    }
    case "ws":
      return new WebSocketClientTransport(new URL(spec.url ?? ""));
  }
}

async function connectOne(spec: NormalizedSpec): Promise<ServerEntry> {
  const specHash = hashSpec(spec);
  try {
    const transport = buildTransport(spec);
    const client = new Client(
      { name: `brAIn-mcp-host:${spec.name}`, version: "0.2.0" },
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
    return { spec, client, transport, tools, connectedAt: Date.now(), specHash, status: "connected" };
  } catch (err) {
    return { spec, status: "error", error: err instanceof Error ? err.message : String(err), specHash };
  }
}

async function disconnect(entry: ServerEntry): Promise<void> {
  if (entry.status !== "connected") return;
  try { await entry.client.close(); } catch { /* ignore */ }
  try { await entry.transport.close(); } catch { /* ignore */ }
}

/**
 * Diff the desired specs vs the current connections and reconcile:
 * - new specs → connect
 * - removed specs → disconnect + drop
 * - changed specs (different hash) → disconnect + reconnect
 * Idempotent.
 */
async function reconcile(nodeId: string, desired: NormalizedSpec[]): Promise<void> {
  const inst = getInstance(nodeId);
  const desiredByName = new Map(desired.map((s) => [s.name, s]));

  // Remove servers no longer wanted, or with a changed hash.
  for (const [name, entry] of [...inst.servers]) {
    const want = desiredByName.get(name);
    if (!want || hashSpec(want) !== entry.specHash) {
      await disconnect(entry);
      inst.servers.delete(name);
    }
  }

  // Connect new / re-add changed.
  for (const spec of desired) {
    if (inst.servers.has(spec.name)) continue;
    const entry = await connectOne(spec);
    inst.servers.set(spec.name, entry);
    if (entry.status === "connected") {
      logger.info({ server: spec.name, tools: entry.tools.length }, "mcp-host: connected");
    } else {
      logger.error({ server: spec.name, error: entry.error }, "mcp-host: failed to connect");
    }
  }
}

function flatToolList(inst: Instance): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const e of inst.servers.values()) {
    if (e.status === "connected") out.push(...e.tools);
  }
  return out;
}

function pickServer(inst: Instance, req: MCPCallRequest): ConnectedServer | null {
  if (req.server) {
    const e = inst.servers.get(req.server);
    return e?.status === "connected" ? e : null;
  }
  for (const e of inst.servers.values()) {
    if (e.status === "connected" && e.tools.some((t) => t.name === req.tool)) return e;
  }
  return null;
}

// === Lifecycle ===

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  const overrides = info.config_overrides ?? {};
  await reconcile(info.id, parseSpecs(overrides));
};

export const teardown: NodeTeardown = async (info: NodeInfo) => {
  const inst = instances.get(info.id);
  if (!inst) return;
  for (const e of inst.servers.values()) await disconnect(e);
  instances.delete(info.id);
};

export const handler: NodeHandler = async (ctx) => {
  const inst = getInstance(ctx.node.id);

  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.host.reload") {
      // Re-read config and reconcile. Lets the dashboard PATCH
      // config_overrides then publish this topic to take effect
      // without killing the node.
      const overrides = ctx.node.config_overrides ?? {};
      await reconcile(ctx.node.id, parseSpecs(overrides));
      ctx.publish("mcp.tools.available", {
        type: "text", criticality: 1,
        payload: { content: JSON.stringify({ tools: flatToolList(inst) }) },
        metadata: { tools: flatToolList(inst), reload: true },
      });
      continue;
    }

    if (msg.topic === "mcp.tools.list") {
      const tools = flatToolList(inst);
      ctx.publish("mcp.tools.available", {
        type: "text", criticality: 1,
        payload: { content: JSON.stringify({ tools }) },
        metadata: { tools },
      });
      continue;
    }

    if (msg.topic !== "mcp.call") continue;

    let req: MCPCallRequest;
    try {
      req = JSON.parse((msg.payload as TextPayload).content) as MCPCallRequest;
    } catch {
      ctx.respond(JSON.stringify({ error: "mcp.call payload must be JSON {server?, tool, arguments?}" }));
      continue;
    }
    if (!req.tool) {
      ctx.respond(JSON.stringify({ error: "mcp.call requires `tool`" }));
      continue;
    }

    const conn = pickServer(inst, req);
    if (!conn) {
      ctx.respond(JSON.stringify({
        error: `no connected MCP server knows tool '${req.tool}'`,
        servers: Array.from(inst.servers.keys()),
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

/**
 * Snapshot of one node-instance's connections — exposed so the API /
 * dashboard can surface server status without reaching into private
 * state. Returns one entry per configured server, including failed
 * connections (status="error").
 */
export function getNodeMCPSnapshot(nodeId: string): Array<{
  name: string;
  transport: NormalizedSpec["transport"];
  status: "connected" | "error";
  url?: string;
  command?: string;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
  connectedAt?: number;
}> {
  const inst = instances.get(nodeId);
  if (!inst) return [];
  return [...inst.servers.values()].map((e) => ({
    name: e.spec.name,
    transport: e.spec.transport,
    status: e.status,
    url: e.spec.url,
    command: e.spec.command,
    toolCount: e.status === "connected" ? e.tools.length : 0,
    tools: e.status === "connected" ? e.tools.map((t) => ({ name: t.name, description: t.description })) : [],
    error: e.status === "error" ? e.error : undefined,
    connectedAt: e.status === "connected" ? e.connectedAt : undefined,
  }));
}
