/**
 * mcp-server — bridges ONE external MCP server onto the brAIn bus.
 *
 * Topology: each MCP tool gets its own subscription topic
 * `mcp.<alias>.<tool>`. Callers publish args there; the handler runs
 * the tool and replies via `reply_to` (if set) or the default
 * `mcp.<alias>.<tool>.result` topic.
 *
 * Control plane (also alias-scoped):
 *   mcp.<alias>.tools.request    → mcp.<alias>.tools          (descriptor list)
 *   mcp.<alias>.status.request   → mcp.<alias>.status         (connection state)
 *   mcp.<alias>.reload           re-read config_overrides + reconnect
 *   mcp.<alias>.oauth.callback   delivers OAuth code from /mcp/oauth/callback
 *                                → mcp.<alias>.oauth.required surfaced when consent needed
 *
 * One mcp-server instance owns exactly one connection. Many instances
 * coexist in the same process (keyed by node id) so spawning a fresh
 * mcp-server for a new entry in mcp-config doesn't disturb the others.
 *
 * Spawned by mcp-config; never wired by hand. The brain (or any
 * other node) calls tools by publishing on the per-tool topic.
 */
import type {
  NodeHandler, NodeContext, NodeInfo, NodeOnSpawn, NodeTeardown, TextPayload,
} from "@brain/sdk";
import { parseSpec, type NormalizedSpec } from "./parse";
import {
  type ServerEntry, type ToolDescriptor,
  connectOne, disconnect, finishOAuth,
} from "./connect";
import type { OAuthEvent } from "./oauth";

interface NodeRuntime {
  alias: string;
  spec: NormalizedSpec;
  entry: ServerEntry | null;
  subscribedToolTopics: Set<string>;
  /** Buffered OAuth events fired outside a handler tick (onSpawn / saveTokens callback). */
  pendingOAuthEvents: OAuthEvent[];
  /** True when status should be re-published next tick. */
  statusDirty: boolean;
}

const runtimes = new Map<string, NodeRuntime>();

function getRt(nodeId: string): NodeRuntime | undefined {
  return runtimes.get(nodeId);
}

function bufferOAuthEvent(nodeId: string, e: OAuthEvent): void {
  const rt = runtimes.get(nodeId);
  if (!rt) return;
  rt.pendingOAuthEvents.push(e);
  rt.statusDirty = true;
}

// === Topics (alias-scoped) ===

const TOPIC = {
  tools: (a: string) => `mcp.${a}.tools`,
  toolsRequest: (a: string) => `mcp.${a}.tools.request`,
  status: (a: string) => `mcp.${a}.status`,
  statusRequest: (a: string) => `mcp.${a}.status.request`,
  reload: (a: string) => `mcp.${a}.reload`,
  oauthRequired: (a: string) => `mcp.${a}.oauth.required`,
  oauthCallback: (a: string) => `mcp.${a}.oauth.callback`,
  toolCall: (a: string, t: string) => `mcp.${a}.${t}`,
  toolResult: (a: string, t: string) => `mcp.${a}.${t}.result`,
};

// === Snapshots ===

function snapshotEntry(rt: NodeRuntime): {
  alias: string;
  transport: NormalizedSpec["transport"];
  status: "connected" | "error" | "pending-auth" | "unconfigured";
  url?: string;
  command?: string;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
  authorizationUrl?: string;
  connectedAt?: number;
} {
  const e = rt.entry;
  if (!e) {
    return {
      alias: rt.alias, transport: rt.spec.transport, status: "unconfigured",
      url: rt.spec.url, command: rt.spec.command, toolCount: 0, tools: [],
    };
  }
  return {
    alias: rt.alias,
    transport: e.spec.transport,
    status: e.status,
    url: e.spec.url,
    command: e.spec.command,
    toolCount: e.status === "connected" ? e.tools.length : 0,
    tools: e.status === "connected" ? e.tools.map((t) => ({ name: t.name, description: t.description })) : [],
    error: e.status === "error" ? e.error : undefined,
    authorizationUrl: e.status === "pending-auth" ? e.authorizationUrl : undefined,
    connectedAt: e.status === "connected" ? e.connectedAt : undefined,
  };
}

function pickTool(rt: NodeRuntime, name: string): ToolDescriptor | null {
  if (rt.entry?.status !== "connected") return null;
  return rt.entry.tools.find((t) => t.name === name) ?? null;
}

// === Subscription reconciliation ===

function reconcileToolSubs(ctx: NodeContext, rt: NodeRuntime): void {
  const desired = new Map<string, ToolDescriptor>();
  if (rt.entry?.status === "connected") {
    for (const t of rt.entry.tools) desired.set(TOPIC.toolCall(rt.alias, t.name), t);
  }
  for (const topic of rt.subscribedToolTopics) {
    if (!desired.has(topic)) {
      ctx.unsubscribe(topic);
      rt.subscribedToolTopics.delete(topic);
    }
  }
  for (const [topic, t] of desired) {
    if (!rt.subscribedToolTopics.has(topic)) {
      // Pass the upstream MCP tool's description + inputSchema so the
      // framework's own MCP service can re-expose them as first-class
      // tools instead of opaque bus topics.
      ctx.subscribe(topic, {
        description: t.description || `${rt.alias}: ${t.name}`,
        inputSchema: (t.inputSchema ?? undefined) as Record<string, unknown> | undefined,
      });
      rt.subscribedToolTopics.add(topic);
    }
  }
}

function publishStatus(ctx: NodeContext, rt: NodeRuntime): void {
  const snap = snapshotEntry(rt);
  ctx.publish(TOPIC.status(rt.alias), {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify(snap) },
    metadata: { ...snap },
  });
}

function publishTools(ctx: NodeContext, rt: NodeRuntime): void {
  const tools = rt.entry?.status === "connected" ? rt.entry.tools : [];
  ctx.publish(TOPIC.tools(rt.alias), {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ alias: rt.alias, tools }) },
    metadata: { alias: rt.alias, tools },
  });
}

function drainOAuthEvents(ctx: NodeContext, rt: NodeRuntime): void {
  for (const e of rt.pendingOAuthEvents) {
    ctx.publish(TOPIC.oauthRequired(rt.alias), {
      type: "text", criticality: 1,
      payload: { content: JSON.stringify(e) },
      metadata: { ...e },
    });
  }
  rt.pendingOAuthEvents = [];
}

// === Connection lifecycle ===

async function ensureConnected(ctx: NodeContext, rt: NodeRuntime): Promise<void> {
  if (rt.entry?.status === "connected") return;
  ctx.log("info", `connecting to ${rt.spec.transport}://${rt.spec.url ?? rt.spec.command ?? ""}`);
  rt.entry = await connectOne(ctx.node.id, rt.spec, (e) => bufferOAuthEvent(ctx.node.id, e));
  if (rt.entry.status === "connected") {
    ctx.log("info", `connected — ${rt.entry.tools.length} tool(s)`);
  } else if (rt.entry.status === "pending-auth") {
    ctx.log("info", `awaiting OAuth consent`);
  } else {
    ctx.log("error", `connect failed: ${rt.entry.error}`);
  }
  reconcileToolSubs(ctx, rt);
  rt.statusDirty = true;
}

async function reload(ctx: NodeContext, rt: NodeRuntime): Promise<void> {
  if (rt.entry) await disconnect(rt.entry);
  rt.entry = null;
  const fresh = parseSpec(ctx.node.config_overrides ?? {});
  if (!fresh) {
    ctx.log("error", "reload: invalid config_overrides — expected {alias, spec}");
    rt.statusDirty = true;
    return;
  }
  rt.alias = fresh.alias;
  rt.spec = fresh;
  await ensureConnected(ctx, rt);
}

// === Lifecycle hooks ===

export const onSpawn: NodeOnSpawn = (info: NodeInfo): void => {
  const overrides = info.config_overrides ?? {};
  const spec = parseSpec(overrides);
  if (!spec) {
    // Register an empty runtime so the handler reports "unconfigured".
    runtimes.set(info.id, {
      alias: typeof overrides.alias === "string" ? overrides.alias : "unconfigured",
      spec: { alias: "unconfigured", transport: "stdio" },
      entry: null, subscribedToolTopics: new Set(),
      pendingOAuthEvents: [], statusDirty: true,
    });
    return;
  }
  runtimes.set(info.id, {
    alias: spec.alias, spec, entry: null,
    subscribedToolTopics: new Set(), pendingOAuthEvents: [], statusDirty: true,
  });
};

export const teardown: NodeTeardown = async (info: NodeInfo): Promise<void> => {
  const rt = runtimes.get(info.id);
  if (!rt) return;
  if (rt.entry) await disconnect(rt.entry);
  runtimes.delete(info.id);
};

// === Handler ===

async function handleToolCall(ctx: NodeContext, rt: NodeRuntime, msg: { topic: string; payload: TextPayload; reply_to?: string }): Promise<void> {
  const toolName = msg.topic.slice(`mcp.${rt.alias}.`.length);
  const tool = pickTool(rt, toolName);
  if (!tool) {
    ctx.log("warn", `tool ${toolName} not available`);
    return;
  }
  let args: Record<string, unknown> = {};
  try {
    if (msg.payload.content.trim()) {
      args = JSON.parse(msg.payload.content) as Record<string, unknown>;
    }
  } catch {
    ctx.log("error", `tool ${toolName}: invalid JSON arguments`);
    return;
  }

  if (rt.entry?.status !== "connected") return;
  const conn = rt.entry;
  try {
    ctx.log("info", `call → ${toolName}`);
    const result = await conn.client.callTool({ name: tool.name, arguments: args }, undefined, { signal: ctx.signal });
    const replyTopic = msg.reply_to ?? TOPIC.toolResult(rt.alias, toolName);
    ctx.publish(replyTopic, {
      type: "text", criticality: 1,
      payload: { content: JSON.stringify(result) },
      metadata: { alias: rt.alias, tool: toolName },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.log("error", `tool ${toolName} failed: ${errMsg}`);
    const replyTopic = msg.reply_to ?? TOPIC.toolResult(rt.alias, toolName);
    ctx.publish(replyTopic, {
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ error: errMsg }) },
      metadata: { alias: rt.alias, tool: toolName, error: true },
    });
  }
}

export const handler: NodeHandler = async (ctx: NodeContext): Promise<void> => {
  const rt = getRt(ctx.node.id);
  if (!rt) {
    ctx.log("error", "no runtime — onSpawn skipped?");
    return;
  }

  // First tick after onSpawn: connect + subscribe to control topics.
  if (rt.entry === null && rt.spec.alias !== "unconfigured") {
    ctx.subscribe(TOPIC.toolsRequest(rt.alias));
    ctx.subscribe(TOPIC.statusRequest(rt.alias));
    ctx.subscribe(TOPIC.reload(rt.alias));
    ctx.subscribe(TOPIC.oauthCallback(rt.alias));
    await ensureConnected(ctx, rt);
  }

  for (const msg of ctx.messages) {
    if (msg.topic === TOPIC.reload(rt.alias)) {
      await reload(ctx, rt);
      continue;
    }
    if (msg.topic === TOPIC.statusRequest(rt.alias)) {
      rt.statusDirty = true;
      continue;
    }
    if (msg.topic === TOPIC.toolsRequest(rt.alias)) {
      publishTools(ctx, rt);
      continue;
    }
    if (msg.topic === TOPIC.oauthCallback(rt.alias)) {
      try {
        const data = JSON.parse((msg.payload as TextPayload).content) as { code: string };
        if (rt.entry?.status === "pending-auth" && typeof data.code === "string") {
          rt.entry = await finishOAuth(rt.entry, ctx.node.id, data.code, (e) => bufferOAuthEvent(ctx.node.id, e));
          if (rt.entry.status === "connected") {
            ctx.log("info", `OAuth complete — ${rt.entry.tools.length} tool(s)`);
          } else if (rt.entry.status === "error") {
            ctx.log("error", `OAuth post-callback connect failed: ${rt.entry.error}`);
          }
          reconcileToolSubs(ctx, rt);
          rt.statusDirty = true;
        }
      } catch (err) {
        ctx.log("error", `oauth.callback parse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (msg.topic.startsWith(`mcp.${rt.alias}.`)) {
      await handleToolCall(ctx, rt, msg as { topic: string; payload: TextPayload; reply_to?: string });
      continue;
    }
  }

  drainOAuthEvents(ctx, rt);
  if (rt.statusDirty) {
    rt.statusDirty = false;
    publishStatus(ctx, rt);
  }
};

/** Snapshot for tests / future API endpoints. */
export function getServerSnapshot(nodeId: string): ReturnType<typeof snapshotEntry> | null {
  const rt = runtimes.get(nodeId);
  return rt ? snapshotEntry(rt) : null;
}
