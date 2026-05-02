/**
 * Build MCP tool catalogs from the network. The rule is: every
 * subscription on a node that carries a `description` becomes an
 * MCP tool; descriptionless subs are not exposed (treated as
 * internal plumbing).
 *
 * Two views:
 *   - per-node : just one node's subs, tool name = the topic itself
 *                (callers already know which node they're talking to)
 *   - federated: every node's subs, tool name = `<nodeName>__<topic>`
 *                so collisions across nodes are namespaced away
 */
import type { NodeInfo } from "@brain/sdk";

export interface MCPTool {
  /** Tool name as advertised to MCP clients. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Bus topic the args are published on. */
  topic: string;
  /** Owning node — populated for the federated view. */
  nodeId?: string;
  nodeName?: string;
}

const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = { type: "object" };

export function toolsForNode(node: NodeInfo): MCPTool[] {
  const out: MCPTool[] = [];
  for (const sub of node.subscriptions) {
    if (!sub.description) continue;
    out.push({
      name: sub.topic,
      description: sub.description,
      inputSchema: sub.inputSchema ?? DEFAULT_INPUT_SCHEMA,
      topic: sub.topic,
      nodeId: node.id,
      nodeName: node.name,
    });
  }
  return out;
}

/**
 * Federated catalog over all nodes. Tool names get the
 * `<nodeName>__<topic>` prefix so two nodes that subscribe to the
 * same topic don't collide. Falls back to id-prefix if names
 * collide too.
 */
export function federatedTools(nodes: NodeInfo[]): MCPTool[] {
  const nameCounts = new Map<string, number>();
  for (const n of nodes) nameCounts.set(n.name, (nameCounts.get(n.name) ?? 0) + 1);

  const out: MCPTool[] = [];
  for (const node of nodes) {
    const prefix = (nameCounts.get(node.name) ?? 0) > 1 ? node.id.slice(0, 8) : node.name;
    for (const sub of node.subscriptions) {
      if (!sub.description) continue;
      out.push({
        name: `${prefix}__${sub.topic}`,
        description: `[${node.name}] ${sub.description}`,
        inputSchema: sub.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        topic: sub.topic,
        nodeId: node.id,
        nodeName: node.name,
      });
    }
  }
  return out;
}

/**
 * Look up a node by id (exact) then by name. Returns the node, or
 * the list of candidates when the lookup is ambiguous, or null.
 */
export type ResolveResult =
  | { kind: "ok"; node: NodeInfo }
  | { kind: "ambiguous"; candidates: NodeInfo[] }
  | { kind: "not-found" };

export function resolveNode(nodes: NodeInfo[], idOrName: string): ResolveResult {
  const byId = nodes.find((n) => n.id === idOrName);
  if (byId) return { kind: "ok", node: byId };
  const byName = nodes.filter((n) => n.name === idOrName);
  if (byName.length === 1) return { kind: "ok", node: byName[0] };
  if (byName.length > 1) return { kind: "ambiguous", candidates: byName };
  return { kind: "not-found" };
}
