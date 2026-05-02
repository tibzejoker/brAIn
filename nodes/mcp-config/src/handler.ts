/**
 * mcp-config — manager that owns the global `mcpServers` JSON and
 * reconciles by spawning / killing mcp-server children, one per entry.
 *
 * Config shape (same one Claude Desktop / Cursor / Cline use):
 *
 *   { "mcpServers": {
 *       "notion":  { "type": "http",  "url": "https://mcp.notion.com/mcp" },
 *       "fs":      { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
 *       "github":  { "type": "http",  "url": "https://api.githubcopilot.com/mcp/",
 *                    "oauthClientId": "${env:GH_CLIENT_ID}" }
 *   }}
 *
 * Each entry → one child node `mcp-<alias>` of type `mcp-server` with
 * config_overrides `{ alias, spec }`. Diff is by alias + JSON-stable
 * hash of the spec: new alias spawns, removed alias kills, changed
 * spec restarts (kill + spawn — OAuth tokens are persisted on disk so
 * the user is not re-prompted).
 *
 * Topics:
 *   mcp.config.reload   re-read own config_overrides + reconcile
 *
 * Authority: ELEVATED (1) so ctx.spawn / ctx.kill route through the
 * lifecycle. Children inherit BASIC by default.
 */
import type {
  NodeHandler, NodeContext, NodeInfo, NodeOnSpawn, NodeTeardown,
} from "@brain/sdk";

interface ChildRecord {
  nodeId: string;
  specHash: string;
}

interface ManagerRuntime {
  /** alias → spawned child id + spec hash */
  children: Map<string, ChildRecord>;
  /** True when reconcile should run on the next handler tick. */
  reconcileDirty: boolean;
}

const runtimes = new Map<string, ManagerRuntime>();

function getRt(nodeId: string): ManagerRuntime {
  let rt = runtimes.get(nodeId);
  if (!rt) {
    rt = { children: new Map(), reconcileDirty: true };
    runtimes.set(nodeId, rt);
  }
  return rt;
}

// === Spec extraction ===

interface ParsedEntry {
  alias: string;
  spec: Record<string, unknown>;
  /** JSON-stable hash, used to detect "changed → restart". */
  hash: string;
}

function stableHash(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Pull `mcpServers: { alias: spec }` out of the manager's
 * config_overrides. Tolerates minor mistakes (non-object entries are
 * skipped silently with a log). Returns an empty list if the field
 * is absent — the manager then kills all children.
 */
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
    const spec = raw as Record<string, unknown>;
    out.push({ alias, spec, hash: stableHash(spec) });
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
    if (ctx.kill(nodeId, reason)) {
      ctx.log("info", `- killed mcp-${alias} (${reason})`);
    } else {
      ctx.log("warn", `kill returned false for mcp-${alias} — may already be gone`);
    }
  } catch (err) {
    ctx.log("error", `failed to kill mcp-${alias}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function reconcile(ctx: NodeContext, rt: ManagerRuntime): Promise<void> {
  const desired = parseEntries(ctx.node.config_overrides ?? {}, ctx.log);
  const desiredByAlias = new Map(desired.map((e) => [e.alias, e]));

  for (const [alias, rec] of [...rt.children]) {
    const want = desiredByAlias.get(alias);
    if (!want) {
      killChild(ctx, alias, rec.nodeId, "removed from config");
      rt.children.delete(alias);
    } else if (want.hash !== rec.specHash) {
      killChild(ctx, alias, rec.nodeId, "spec changed");
      rt.children.delete(alias);
    }
  }

  for (const entry of desired) {
    if (rt.children.has(entry.alias)) continue;
    const childId = await spawnChild(ctx, entry);
    if (childId) rt.children.set(entry.alias, { nodeId: childId, specHash: entry.hash });
  }
}

function publishStatus(ctx: NodeContext, rt: ManagerRuntime): void {
  const children = [...rt.children.entries()].map(([alias, rec]) => ({ alias, nodeId: rec.nodeId }));
  ctx.publish("mcp.config.status", {
    type: "text", criticality: 1,
    payload: { content: JSON.stringify({ children }) },
    metadata: { children, count: children.length },
  });
}

// === Lifecycle ===

export const onSpawn: NodeOnSpawn = (info: NodeInfo): void => {
  const rt = getRt(info.id);
  rt.reconcileDirty = true;
};

export const teardown: NodeTeardown = (info: NodeInfo): void => {
  // We do NOT auto-kill children on teardown: the user may want to
  // restart the manager without disturbing a working MCP swarm. If
  // they want a full reset, they can `killAll` explicitly. Leaving
  // children orphaned is preferable to surprise-killing connected
  // MCP servers (and re-prompting OAuth) on every config edit.
  runtimes.delete(info.id);
};

export const handler: NodeHandler = async (ctx: NodeContext): Promise<void> => {
  const rt = getRt(ctx.node.id);

  for (const msg of ctx.messages) {
    if (msg.topic === "mcp.config.reload") {
      rt.reconcileDirty = true;
    }
  }

  if (rt.reconcileDirty) {
    rt.reconcileDirty = false;
    await reconcile(ctx, rt);
    publishStatus(ctx, rt);
  }
};
