/**
 * mcp-config — manager + federation hub for MCP servers.
 *
 * **Manager role.** Owns the global `mcpServers` JSON (same shape as
 * Claude Desktop / Cursor / Cline) and reconciles by spawning /
 * killing mcp-server children, one per entry. Source of truth for
 * the children list is the live registry (filtered by `spawned_by`),
 * not in-memory state, so a process restart re-discovers what it
 * owns. Diff is by alias + JSON-stable hash of the spec — new alias
 * spawns, removed alias kills, changed spec restarts.
 *
 * **Federation hub role.** Aggregates the tool catalogs of all its
 * children and exposes a single entry point so callers don't need to
 * know which alias hosts which tool:
 *
 *   mcp.config.tools.request  → mcp.config.tools     namespaced as `<alias>__<tool>`
 *   mcp.config.call           → routes by prefix     payload: {tool, args, [reply_to]}
 *   mcp.config.set            mutate own config_overrides via the bus, then reconcile
 *   mcp.config.reload         re-read config_overrides + reconcile
 *
 * Authority: ELEVATED (1) so ctx.spawn / ctx.kill route through the
 * lifecycle. Children inherit BASIC by default.
 */
import type {
  NodeHandler, NodeContext, NodeInfo, NodeOnSpawn, NodeTeardown, TextPayload,
} from "@brain/sdk";
import {
  type ManagerRuntime, type ToolDescriptor, getRt, runtimes,
  rebuildChildrenFromRegistry, reconcileChildSubscriptions,
} from "./runtime";

interface ParsedEntry { alias: string; spec: Record<string, unknown>; hash: string }

function stableHash(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function parseEntries(overrides: Record<string, unknown>, log: NodeContext["log"]): ParsedEntry[] {
  const map = overrides.mcpServers;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    if (map !== undefined) log("warn", "config_overrides.mcpServers must be an object map");
    return [];
  }
  const out: ParsedEntry[] = [];
  for (const [alias, raw] of Object.entries(map as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      log("warn", `mcpServers.${alias}: skipped — not an object`);
      continue;
    }
    out.push({ alias, spec: raw as Record<string, unknown>, hash: stableHash(raw as Record<string, unknown>) });
  }
  return out;
}

// === Reconciliation ===

async function spawnChild(ctx: NodeContext, entry: ParsedEntry): Promise<string | null> {
  try {
    const child = await ctx.spawn({
      type: "mcp-server",
      name: `mcp-${entry.alias}`,
      description: `MCP server bridge for ${entry.alias}`,
      config_overrides: { alias: entry.alias, spec: entry.spec },
    });
    ctx.log("info", `+ spawned mcp-${entry.alias} (${child.id})`);
    return child.id;
  } catch (err) {
    ctx.log("error", `failed to spawn mcp-${entry.alias}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function killChild(ctx: NodeContext, alias: string, nodeId: string, reason: string): void {
  try {
    if (ctx.kill(nodeId, reason)) ctx.log("info", `- killed mcp-${alias} (${reason})`);
    else ctx.log("warn", `kill returned false for mcp-${alias} — may already be gone`);
  } catch (err) {
    ctx.log("error", `failed to kill mcp-${alias}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function reconcile(ctx: NodeContext, rt: ManagerRuntime): Promise<void> {
  rebuildChildrenFromRegistry(ctx, rt, stableHash);
  const desired = parseEntries(ctx.node.config_overrides ?? {}, ctx.log);
  const desiredByAlias = new Map(desired.map((e) => [e.alias, e]));

  for (const [alias, rec] of [...rt.children]) {
    const want = desiredByAlias.get(alias);
    if (!want) {
      killChild(ctx, alias, rec.nodeId, "removed from config");
      rt.children.delete(alias);
      rt.toolCache.delete(alias);
    } else if (want.hash !== rec.specHash) {
      killChild(ctx, alias, rec.nodeId, "spec changed");
      rt.children.delete(alias);
      rt.toolCache.delete(alias);
    }
  }

  for (const entry of desired) {
    if (rt.children.has(entry.alias)) continue;
    const childId = await spawnChild(ctx, entry);
    if (childId) rt.children.set(entry.alias, { nodeId: childId, specHash: entry.hash });
  }

  reconcileChildSubscriptions(ctx, rt);
}

// === Federation ===

function aggregatedTools(rt: ManagerRuntime): Array<ToolDescriptor & { alias: string; qualified: string }> {
  const out: Array<ToolDescriptor & { alias: string; qualified: string }> = [];
  for (const [alias, tools] of rt.toolCache) {
    for (const t of tools) out.push({ ...t, alias, qualified: `${alias}__${t.name}` });
  }
  return out;
}

function publishStatus(ctx: NodeContext, rt: ManagerRuntime): void {
  const children = [...rt.children.entries()].map(([alias, rec]) => ({
    alias, nodeId: rec.nodeId, toolCount: rt.toolCache.get(alias)?.length ?? 0,
  }));
  ctx.publish("mcp.config.status", {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ children }) },
    metadata: { children, count: children.length },
  });
}

function publishTools(ctx: NodeContext, rt: ManagerRuntime): void {
  const tools = aggregatedTools(rt);
  ctx.publish("mcp.config.tools", {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ tools }) },
    metadata: { tools, count: tools.length },
  });
}

interface CallRequest { tool: string; args?: Record<string, unknown>; reply_to?: string }

function routeCall(ctx: NodeContext, rt: ManagerRuntime, msg: { payload: TextPayload; reply_to?: string }): void {
  let req: CallRequest;
  try { req = JSON.parse(msg.payload.content) as CallRequest; }
  catch { ctx.log("error", "mcp.config.call: invalid JSON payload"); return; }
  if (typeof req.tool !== "string") { ctx.log("error", "mcp.config.call: missing `tool`"); return; }
  const sep = req.tool.indexOf("__");
  if (sep < 0) { ctx.log("error", `mcp.config.call: tool '${req.tool}' missing alias prefix (use 'alias__name')`); return; }
  const alias = req.tool.slice(0, sep);
  const toolName = req.tool.slice(sep + 2);
  if (!rt.children.has(alias)) { ctx.log("error", `mcp.config.call: unknown alias '${alias}'`); return; }
  const replyTo = req.reply_to ?? msg.reply_to ?? "mcp.config.call.result";
  ctx.publish(`mcp.${alias}.${toolName}`, {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify(req.args ?? {}) },
    reply_to: replyTo,
    metadata: { alias, tool: toolName, qualified: req.tool },
  });
  ctx.log("info", `route ${req.tool} → mcp.${alias}.${toolName} (reply→${replyTo})`);
}

function setConfigFromBus(ctx: NodeContext, rt: ManagerRuntime, payload: TextPayload): void {
  let parsed: { mcpServers?: unknown };
  try { parsed = JSON.parse(payload.content) as { mcpServers?: unknown }; }
  catch { ctx.log("error", "mcp.config.set: invalid JSON"); return; }
  if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers)) {
    ctx.log("error", "mcp.config.set: payload must be {mcpServers: {...}}");
    return;
  }
  const overrides = ctx.node.config_overrides ?? {};
  overrides.mcpServers = parsed.mcpServers;
  ctx.node.config_overrides = overrides;
  rt.reconcileDirty = true;
  ctx.log("info", `config.set: ${Object.keys(parsed.mcpServers).length} server(s) in new config`);
}

// === Lifecycle ===

const CONTROL_TOPICS = [
  "mcp.config.reload",
  "mcp.config.tools.request",
  "mcp.config.call",
  "mcp.config.set",
];

/**
 * Subscribe to every control topic the manager handles, idempotently.
 * default_subscriptions only takes effect at spawn time, so when we
 * add a new topic to config.json existing nodes don't pick it up.
 * Skip topics already subscribed to avoid duplicate mailboxes.
 */
function ensureControlSubs(ctx: NodeContext, rt: ManagerRuntime): void {
  if (rt.controlSubsApplied) return;
  rt.controlSubsApplied = true;
  const existing = new Set(ctx.node.subscriptions.map((s) => s.topic));
  for (const topic of CONTROL_TOPICS) {
    if (!existing.has(topic)) ctx.subscribe(topic);
  }
}

export const onSpawn: NodeOnSpawn = (info: NodeInfo): void => {
  const rt = getRt(info.id);
  rt.reconcileDirty = true;
};

export const teardown: NodeTeardown = (info: NodeInfo): void => {
  // We do NOT auto-kill children on teardown: the user may want to
  // restart the manager without disturbing a working MCP swarm.
  runtimes.delete(info.id);
};

export const handler: NodeHandler = async (ctx: NodeContext): Promise<void> => {
  const rt = getRt(ctx.node.id);
  ensureControlSubs(ctx, rt);

  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.config.reload") { rt.reconcileDirty = true; continue; }
    if (msg.topic === "mcp.config.tools.request") { publishTools(ctx, rt); continue; }
    if (msg.topic === "mcp.config.call") {
      routeCall(ctx, rt, msg as { payload: TextPayload; reply_to?: string });
      continue;
    }
    if (msg.topic === "mcp.config.set") {
      setConfigFromBus(ctx, rt, msg.payload as TextPayload);
      continue;
    }
    // Child status snapshots — refresh the tool cache.
    const m = /^mcp\.([^.]+)\.status$/.exec(msg.topic);
    if (m) {
      const alias = m[1];
      const meta = msg.metadata as { tools?: ToolDescriptor[] } | undefined;
      if (Array.isArray(meta?.tools)) rt.toolCache.set(alias, meta.tools);
    }
  }

  if (rt.reconcileDirty) {
    rt.reconcileDirty = false;
    await reconcile(ctx, rt);
    publishStatus(ctx, rt);
    publishTools(ctx, rt);
  }
};
