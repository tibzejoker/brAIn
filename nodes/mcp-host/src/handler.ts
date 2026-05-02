/**
 * mcp-host — bridges external MCP servers onto the brAIn bus.
 *
 * Configuration uses the `mcpServers` shape that's now the de-facto
 * standard across Claude Desktop / Claude Code / Cursor / Cline / etc.
 * Top-level key is an object map (server name → spec). Each spec
 * auto-discriminates from its fields: presence of `command` →
 * stdio, presence of `url` → http (Streamable, default for remote),
 * explicit `type: "sse" | "ws"` overrides.
 *
 * `${env:VAR}` interpolation in headers / args / env keeps secrets
 * out of the persisted config.
 *
 * OAuth 2.1 + DCR + PKCE is wired by default for http/sse transports
 * via the SDK's authProvider. Servers that need consent (GitHub
 * Copilot MCP, Notion, Linear OAuth-mode, …) end up in `pending-auth`
 * state with an `authorizationUrl`; the dashboard surfaces it as a
 * link, the user opens it, the API's /mcp/oauth/callback delivers
 * the code back via the bus, the host calls finishAuth and connects.
 *
 * Bus topics:
 *   mcp.call                  { server?, tool, arguments? } → mcp.result
 *   mcp.tools.list                                           → mcp.tools.available
 *   mcp.host.reload           diff config_overrides + reconcile
 *   mcp.host.status.request   → mcp.host.status (full server state)
 *   mcp.host.oauth.callback   delivers OAuth code from /mcp/oauth/callback
 *                             → mcp.host.oauth.required surfaced when consent needed
 *
 * Multiple mcp-host instances in the same process keep independent
 * connection state, keyed by node id.
 */
import type {
  NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown, TextPayload,
} from "@brain/sdk";
import { parseSpecs } from "./parse";
import {
  type Instance, type ServerEntry, type ToolDescriptor,
  connectOne, disconnect, finishOAuth, reconcile,
} from "./connect";
import type { OAuthEvent } from "./oauth";

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

function snapshotEntries(inst: Instance): Array<{
  name: string;
  transport: ServerEntry["spec"]["transport"];
  status: "connected" | "error" | "pending-auth";
  url?: string;
  command?: string;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
  authorizationUrl?: string;
  connectedAt?: number;
}> {
  return [...inst.servers.values()].map((e) => ({
    name: e.spec.name,
    transport: e.spec.transport,
    status: e.status,
    url: e.spec.url,
    command: e.spec.command,
    toolCount: e.status === "connected" ? e.tools.length : 0,
    tools: e.status === "connected" ? e.tools.map((t) => ({ name: t.name, description: t.description })) : [],
    error: e.status === "error" ? e.error : undefined,
    authorizationUrl: e.status === "pending-auth" ? e.authorizationUrl : undefined,
    connectedAt: e.status === "connected" ? e.connectedAt : undefined,
  }));
}

function flatToolList(inst: Instance): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const e of inst.servers.values()) {
    if (e.status === "connected") out.push(...e.tools);
  }
  return out;
}

function pickServer(inst: Instance, req: MCPCallRequest): Extract<ServerEntry, { status: "connected" }> | null {
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

/**
 * Pending publishes — keyed by node id. Filled by onSpawn / OAuth
 * provider callbacks (which fire from outside a handler tick where
 * we have ctx), drained on the next handler tick.
 */
const pendingStatus = new Set<string>();
const pendingOAuthEvents = new Map<string, OAuthEvent[]>();

function bufferOAuthEvent(nodeId: string, e: OAuthEvent): void {
  const list = pendingOAuthEvents.get(nodeId) ?? [];
  list.push(e);
  pendingOAuthEvents.set(nodeId, list);
  pendingStatus.add(nodeId);
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  const overrides = info.config_overrides ?? {};
  await reconcile(getInstance(info.id), info.id, parseSpecs(overrides), (e) => bufferOAuthEvent(info.id, e));
  pendingStatus.add(info.id);
};

export const teardown: NodeTeardown = async (info: NodeInfo) => {
  const inst = instances.get(info.id);
  if (!inst) return;
  for (const e of inst.servers.values()) await disconnect(e);
  instances.delete(info.id);
};

function publishStatus(ctx: Parameters<NodeHandler>[0], inst: Instance): void {
  const servers = snapshotEntries(inst);
  ctx.publish("mcp.host.status", {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ node_id: ctx.node.id, servers }) },
    metadata: { node_id: ctx.node.id, servers },
  });
}

export const handler: NodeHandler = async (ctx) => {
  const inst = getInstance(ctx.node.id);

  // Drain any onSpawn / OAuth-callback trigger that asked us to
  // publish on the next tick (they fire outside a handler ctx).
  if (pendingStatus.has(ctx.node.id)) {
    pendingStatus.delete(ctx.node.id);
    const events = pendingOAuthEvents.get(ctx.node.id) ?? [];
    pendingOAuthEvents.delete(ctx.node.id);
    for (const e of events) {
      ctx.publish("mcp.host.oauth.required", {
        type: "text", criticality: 1,
        payload: { content: JSON.stringify(e) },
        metadata: { ...e },
      });
    }
    publishStatus(ctx, inst);
  }

  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.host.reload") {
      const overrides = ctx.node.config_overrides ?? {};
      await reconcile(inst, ctx.node.id, parseSpecs(overrides), (e) => bufferOAuthEvent(ctx.node.id, e));
      publishStatus(ctx, inst);
      ctx.publish("mcp.tools.available", {
        type: "text", criticality: 1,
        payload: { content: JSON.stringify({ tools: flatToolList(inst) }) },
        metadata: { tools: flatToolList(inst), reload: true },
      });
      continue;
    }

    if (msg.topic === "mcp.host.status.request") {
      publishStatus(ctx, inst);
      continue;
    }

    if (msg.topic === "mcp.host.oauth.callback") {
      try {
        const data = JSON.parse((msg.payload as TextPayload).content) as { node_id: string; server_name: string; code: string };
        if (data.node_id !== ctx.node.id) continue;
        await finishOAuth(inst, ctx.node.id, data.server_name, data.code, (e) => bufferOAuthEvent(ctx.node.id, e));
        publishStatus(ctx, inst);
      } catch (err) {
        ctx.log("error", `oauth.callback parse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
 * Snapshot of one node-instance's connections — exposed so callers
 * (tests, future API endpoints) can introspect status without
 * reaching into private state.
 */
export function getNodeMCPSnapshot(nodeId: string): ReturnType<typeof snapshotEntries> {
  const inst = instances.get(nodeId);
  return inst ? snapshotEntries(inst) : [];
}

// Avoid unused import warning when connectOne moves out — re-export.
export { connectOne };
