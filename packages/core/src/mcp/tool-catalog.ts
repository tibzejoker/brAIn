/**
 * Build MCP tool catalogs from the network. Every declared INPUT port
 * becomes an MCP tool — there's no "hidden" tier any more (per the
 * simplified ports model: if you can publish on a topic, the port
 * receiving it is callable, end of story). Legacy descriptionless subs
 * (auto-discovered, no port mapping) are still skipped here so noisy
 * framework topics don't leak.
 *
 * Two views:
 *   - per-node : just one node's ports, tool name = port name
 *                (callers already know which node they're talking to)
 *   - federated: every node's ports, tool name = `<nodeName>__<port>`
 *                so collisions across nodes are namespaced away
 */
import type { NodeInfo, ToolDescriptor } from "@brain/sdk";

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

/**
 * Pick a concrete, publishable bus subject for a port's MCP call surface.
 *
 * Bindings can be wildcards (`alerts.*`, `brain.>`) — that's fine for the
 * SUBSCRIBE side (the node listens broadly), but wildcards aren't valid
 * NATS publish subjects. An MCP client invoking the tool would publish
 * literally on `alerts.*`, which goes nowhere.
 *
 * Resolution order:
 *   1. First bound topic that has no wildcard — use it as-is.
 *   2. If every binding is a wildcard, synthesise one by replacing the
 *      first `*` / `>` segment with the port name. `alerts.*` + port
 *      `alert` → `alerts.alert`. The broad subscription still matches
 *      (a `alerts.*` sub catches `alerts.alert`), so the listener side
 *      is unaffected.
 *   3. No bindings at all → fall back to the port name itself. The port
 *      is "orphan" until someone wires a topic to it, but the MCP catalog
 *      still has a stable handle.
 */
export function resolveCallTopic(portName: string, topics: string[]): string {
  const concrete = topics.find((t) => !/[*>]/.test(t));
  if (concrete) return concrete;
  if (topics.length === 0) return portName;
  // Replace the first wildcard segment with the port name. We split on `.`
  // so we don't accidentally clobber a literal `*` mid-segment (which is
  // invalid NATS anyway, but defensive coding is cheap).
  const tmpl = topics[0];
  const parts = tmpl.split(".").map((seg) => (seg === "*" || seg === ">" ? portName : seg));
  return parts.join(".");
}

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
      // Use a CONCRETE (non-wildcard) topic for the MCP call surface —
      // see resolveCallTopic. The broad subscription on a wildcard binding
      // still matches the synthesised concrete subject, so listeners stay
      // intact.
      const topic = resolveCallTopic(portName, topics);
      for (const t of topics) seenPortTopics.add(t);
      // Every input port is, by definition, callable — it's surfaced as
      // an MCP tool with its declared schema. There's no "hidden" tier;
      // if the type author didn't want a listener exposed they wouldn't
      // have declared it as a port at all.
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
        const topic = resolveCallTopic(portName, topics);
        for (const t of topics) seenPortTopics.add(t);
        // Every input port is callable — see single-node toolsForNode.
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

/**
 * Lower-level shape used by `ctx.tools.list()` and `GET /tools`.
 *
 * Routes through the same {@link resolveCallTopic} as MCPTool — when a port
 * is bound to a wildcard (e.g. `alerts.*`), the listed `topic` is a concrete
 * subject derived from the port name (e.g. `alerts.alert`). The broad
 * subscription still matches, so the listener side is unaffected, but
 * callers — whether MCP clients or other brAIn nodes via `ctx.publish` —
 * always see a publishable subject.
 *
 * Prefer this over walking `node.subscriptions` by hand: the legacy walk
 * misses the port-binding indirection and surfaces invalid topics for
 * wildcard ports.
 */
export function toolDescriptorsForNode(node: NodeInfo): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  const seenPortTopics = new Set<string>();
  if (node.ports?.inputs) {
    for (const [portName, decl] of Object.entries(node.ports.inputs)) {
      const topics = node.port_bindings?.inputs?.[portName] ?? [];
      const topic = resolveCallTopic(portName, topics);
      for (const t of topics) seenPortTopics.add(t);
      out.push({
        node_id: node.id,
        node_type: node.type,
        node_name: node.name,
        topic,
        description: decl.description,
        inputSchema: decl.inputSchema,
      });
    }
  }
  // Backward-compat: surface any non-port-bound public sub. Skip rows
  // that came from port expansion (description prefixed with `[port:`)
  // — they're already covered by the port loop above.
  for (const sub of node.subscriptions) {
    if (sub.internal === true) continue;
    if (seenPortTopics.has(sub.topic)) continue;
    if (sub.description.startsWith("[port:")) continue;
    out.push({
      node_id: node.id,
      node_type: node.type,
      node_name: node.name,
      topic: sub.topic,
      description: sub.description,
      inputSchema: sub.inputSchema,
    });
  }
  return out;
}

export function resolveNode(nodes: NodeInfo[], idOrName: string): ResolveResult {
  const byId = nodes.find((n) => n.id === idOrName);
  if (byId) return { kind: "ok", node: byId };
  const byName = nodes.filter((n) => n.name === idOrName);
  if (byName.length === 1) return { kind: "ok", node: byName[0] };
  if (byName.length > 1) return { kind: "ambiguous", candidates: byName };
  return { kind: "not-found" };
}
