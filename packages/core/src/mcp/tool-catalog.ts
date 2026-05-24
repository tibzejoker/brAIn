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
  /** Optional — MCP spec field. Present when the subscription declares
   *  itself RPC-shaped (`outputSchema` on the SubscriptionConfig).
   *  External clients (Claude Desktop, Cursor) use it to know what
   *  comes back from a call. Absent = caller shouldn't assume a
   *  structured reply (event-only sub). */
  outputSchema?: Record<string, unknown>;
  /** Bus topic the args are published on. */
  topic: string;
  /** Owning node — populated for the federated view. */
  nodeId?: string;
  nodeName?: string;
}

const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = { type: "object" };

export function toolsForNode(node: NodeInfo): MCPTool[] {
  const out: MCPTool[] = [];
  const seenPortTopics = new Set<string>();
  // 2-layer: each declared INPUT port = one MCP tool. Name comes from
  // the port itself (stable across rewiring); the first bound topic is
  // the canonical call surface — extra bindings stay accepted by the
  // bus, so callers can reach the port via any of them.
  if (node.ports?.inputs) {
    for (const [portName, decl] of Object.entries(node.ports.inputs)) {
      const topics = node.port_bindings?.inputs?.[portName] ?? [];
      const topic = topics[0] ?? portName;
      for (const t of topics) seenPortTopics.add(t);
      out.push({
        name: portName,
        description: decl.description,
        inputSchema: decl.inputSchema,
        outputSchema: decl.outputSchema,
        topic,
        nodeId: node.id,
        nodeName: node.name,
      });
    }
  }
  // Legacy fallback: PUBLIC subs not already exposed via a port. Skip
  // anything whose description starts with "[port:" — those are the
  // port-expanded subs we already covered above.
  for (const sub of node.subscriptions) {
    if (!sub.description) continue;
    if (seenPortTopics.has(sub.topic)) continue;
    if (sub.description.startsWith("[port:")) continue;
    out.push({
      name: sub.topic,
      description: sub.description,
      inputSchema: sub.inputSchema ?? DEFAULT_INPUT_SCHEMA,
      outputSchema: sub.outputSchema,
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
    const seenPortTopics = new Set<string>();
    if (node.ports?.inputs) {
      for (const [portName, decl] of Object.entries(node.ports.inputs)) {
        const topics = node.port_bindings?.inputs?.[portName] ?? [];
        const topic = topics[0] ?? portName;
        for (const t of topics) seenPortTopics.add(t);
        out.push({
          name: `${prefix}__${portName}`,
          description: `[${node.name}] ${decl.description}`,
          inputSchema: decl.inputSchema,
          outputSchema: decl.outputSchema,
          topic,
          nodeId: node.id,
          nodeName: node.name,
        });
      }
    }
    for (const sub of node.subscriptions) {
      if (!sub.description) continue;
      if (seenPortTopics.has(sub.topic)) continue;
      if (sub.description.startsWith("[port:")) continue;
      out.push({
        name: `${prefix}__${sub.topic}`,
        description: `[${node.name}] ${sub.description}`,
        inputSchema: sub.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        outputSchema: sub.outputSchema,
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
