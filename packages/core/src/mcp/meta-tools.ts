/**
 * Hierarchical MCP tool catalog.
 *
 * External MCP clients (Claude Desktop, etc.) used to see a flat dump
 * of every node's public subscription as a top-level tool. That gets
 * noisy fast — dozens of nodes, hundreds of tools, no structure. This
 * module replaces the flat exposure with three meta-tools that let the
 * client drill down on demand:
 *
 *   1. `list_nodes`        — what nodes are alive on the network?
 *   2. `list_node_tools`   — what public subs does node X expose?
 *   3. `call_node_tool`    — publish args on `<topic>` from a synthetic
 *                            `system.mcp.<external_client_id>` identity.
 *
 * `call_node_tool` is fire-and-forget: the bus already records the
 * trace, and any reply lands on the target node's response_topic where
 * a follow-up `list_node_tools` + `call_node_tool` chain can pick it
 * up. We don't block the MCP client on a reply that may never come.
 *
 * The per-subscription flat exposure (`federatedTools` / `toolsForNode`)
 * is still exported for the REST `/tools` discovery endpoint and for
 * `ctx.tools.list()` — those are *internal* views of the network. The
 * three meta-tools are what the *external* MCP server advertises.
 */
import { isPublicSubscription, type NodeInfo, type SubscriptionConfig, type ToolDescriptor } from "@brain/sdk";
import type { BrainService } from "../brain.service"; // type-only — avoids
// a runtime cycle (brain.service imports ./mcp/index → meta-tools).
import { logger } from "../logger";

// === Meta-tool descriptors (advertised to external clients) ===

/**
 * The three meta-tools' shape — name + description + JSON-Schema
 * inputSchema, matching the MCP `Tool` shape so the controller can pass
 * them straight through to `ListToolsRequestSchema`.
 */
export interface MetaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const META_TOOL_LIST_NODES = "list_nodes";
export const META_TOOL_LIST_NODE_TOOLS = "list_node_tools";
export const META_TOOL_CALL_NODE_TOOL = "call_node_tool";

export const META_TOOLS: readonly MetaTool[] = [
  {
    name: META_TOOL_LIST_NODES,
    description:
      "List every node currently registered on the brAIn network. " +
      "Returns id, type, name, description, and tags for each node. " +
      "Use this first to discover what's available, then call " +
      "`list_node_tools` on a specific node id to see its public bus topics.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: META_TOOL_LIST_NODE_TOOLS,
    description:
      "List the public bus subscriptions ('tools') exposed by a single " +
      "node. Each entry has the bus topic, a human description, and a " +
      "JSON Schema describing accepted arguments. Internal/private subs " +
      "are filtered out. Returns `{error: 'node not found'}` if the id " +
      "is unknown.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "The target node's uuid as returned by `list_nodes`.",
        },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: META_TOOL_CALL_NODE_TOOL,
    description:
      "Publish `args` on the given node's bus `topic`. Fire-and-forget: " +
      "returns `{ok: true}` immediately. Replies (if any) land on the " +
      "target node's configured response_topic and can be retrieved by " +
      "subscribing to it via a follow-up tool call. The message is " +
      "tagged with a synthetic `system.mcp.<external_client_id>` sender " +
      "so the receiving node sees who initiated the call.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "The target node's uuid (validated against the live registry).",
        },
        topic: {
          type: "string",
          description:
            "Bus topic to publish on. Must be one of the topics returned by " +
            "`list_node_tools(node_id)` — internal subs are not callable.",
        },
        args: {
          type: "object",
          description:
            "Payload to publish. Should conform to the topic's `inputSchema`; " +
            "the bus validates on publish and rejects malformed payloads.",
          additionalProperties: true,
        },
      },
      required: ["node_id", "topic", "args"],
      additionalProperties: false,
    },
  },
] as const;

// === Handler result shapes ===

export interface ListNodesEntry {
  node_id: string;
  node_type: string;
  node_name: string;
  description: string;
  tags: string[];
}

export type ListNodeToolsResult =
  | { error: string }
  | ToolDescriptor[];

export interface CallNodeToolOk { ok: true }
export interface CallNodeToolErr { error: string }
export type CallNodeToolResult = CallNodeToolOk | CallNodeToolErr;

// === Handlers ===

/**
 * Build the three meta-tool handlers bound to a BrainService and an
 * `externalClientId` (e.g. the MCP session id). The id is stamped into
 * the synthetic `from: "system.mcp.<id>"` of `call_node_tool` so traces
 * tie back to the external client that initiated the call.
 *
 * Each handler accepts raw `unknown` args (the MCP SDK hands us the
 * parsed JSON as-is) and returns a JSON-serialisable result. We
 * defensively narrow inside the handler rather than trusting the
 * JSON-Schema validator on the MCP-server side — bad clients exist.
 */
export interface MetaToolHandlers {
  list_nodes(args: unknown): ListNodesEntry[];
  list_node_tools(args: unknown): ListNodeToolsResult;
  call_node_tool(args: unknown): CallNodeToolResult;
}

export function buildMetaToolHandlers(
  brain: BrainService,
  externalClientId: string,
): MetaToolHandlers {
  const fromId = `system.mcp.${externalClientId}`;

  return {
    list_nodes(_args: unknown): ListNodesEntry[] {
      const nodes = brain.instanceRegistry.list();
      return nodes.map((n) => ({
        node_id: n.id,
        node_type: n.type,
        node_name: n.name,
        description: n.description,
        tags: n.tags,
      }));
    },

    list_node_tools(args: unknown): ListNodeToolsResult {
      const nodeId = readStringField(args, "node_id");
      if (!nodeId) return { error: "node_id is required (string)" };

      const node = brain.instanceRegistry.get(nodeId);
      if (!node) return { error: "node not found" };

      return collectPublicTools(node);
    },

    call_node_tool(args: unknown): CallNodeToolResult {
      const nodeId = readStringField(args, "node_id");
      const topic = readStringField(args, "topic");
      const payload = readObjectField(args, "args");

      if (!nodeId) return { error: "node_id is required (string)" };
      if (!topic) return { error: "topic is required (string)" };
      if (!payload) return { error: "args is required (object)" };

      const node = brain.instanceRegistry.get(nodeId);
      if (!node) return { error: "node not found" };

      // Refuse topics that aren't on the node's public surface — keeps
      // external clients from poking at internal listeners that have no
      // declared schema.
      const publicTopics = new Set(
        node.subscriptions
          .filter((s: SubscriptionConfig) => isPublicSubscription(s))
          .map((s) => s.topic),
      );
      if (!publicTopics.has(topic)) {
        return { error: `topic '${topic}' is not a public tool on node ${nodeId}` };
      }

      try {
        brain.bus.publish({
          from: fromId,
          topic,
          type: "text",
          criticality: 3,
          payload: { content: JSON.stringify(payload) },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, topic, nodeId, fromId }, "mcp.call_node_tool publish failed");
        return { error: msg };
      }
      return { ok: true };
    },
  };
}

// === Internals ===

function collectPublicTools(node: NodeInfo): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const sub of node.subscriptions) {
    if (!isPublicSubscription(sub)) continue;
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

function readStringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[field];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readObjectField(args: unknown, field: string): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[field];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}
