import { BrainService, logger } from "@brain/core";
import type { NodeState } from "@brain/sdk";
import { resolveRoute } from "./message-formatter";

const log = logger.child({ node: "brain-tools" });

export interface ToolResult {
  [key: string]: unknown;
}

function getBrain(): BrainService {
  // BrainService.current may be null in dual-package scenarios (vitest aliases
  // vs compiled node_modules). Fall back to the globalThis singleton.
  const instance = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!instance) throw new Error("BrainService not initialized");
  return instance;
}

export async function executeBrainTool(
  toolName: string,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const brain = getBrain();

  switch (toolName) {
    case "inspect_network":
      return inspectNetwork(brain, args);
    case "inspect_node":
      return inspectNode(brain, args);
    case "find_nodes":
      return findNodes(brain, args);
    case "spawn_node":
      return spawnNode(brain, args, callerNodeId);
    case "kill_node":
      return killNode(brain, args, callerNodeId);
    case "stop_node":
      return stopNode(brain, args, callerNodeId);
    case "start_node":
      return startNode(brain, args, callerNodeId);
    case "wake_node":
      return wakeNode(brain, args, callerNodeId);
    case "rewire":
      return rewire(brain, args);
    case "publish_message":
      return publishMessage(brain, args, callerNodeId);
    case "get_message_history":
      return getMessageHistory(brain, args);
    case "list_types":
      return listTypes(brain);
    case "think":
      return think(args);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

export const BRAIN_TOOL_DESCRIPTIONS = `
Available tools (respond with ONE JSON tool call at a time):

## Network inspection
- inspect_network(): Returns a snapshot of all nodes, their states, subscriptions, and connections.
- inspect_node(node_id): Returns detailed info about a specific node.
- find_nodes(query?, tags?, state?): Search for nodes by text query, tags, or state.
- get_message_history(topic?, last?, min_criticality?): View recent messages on the bus.
- list_types(): List all available node types that can be spawned.

## Node lifecycle
- spawn_node(type, name, subscriptions?, config_overrides?, description?): Create a new node instance.
- kill_node(node_id, reason?): Permanently destroy a node.
- stop_node(node_id, reason?): Pause a node (can be restarted).
- start_node(node_id): Restart a stopped node.
- wake_node(node_id, message?): Wake a sleeping node.

## Network wiring
- rewire(node_id, add_topics?, remove_topics?): Modify a node's subscriptions.
- publish_message(topic, content, criticality?): Publish a message on any topic.

## Thinking
- think(thought): Write down your reasoning. This is not sent to anyone — it's just for you to organize your thoughts before acting.

Format: {"tool": "tool_name", "args": {"key": "value"}}
`;

function inspectNetwork(brain: BrainService, args: Record<string, unknown>): Promise<ToolResult> {
  const nodes = brain.getNetworkSnapshot({
    state: (args.state as NodeState | "all" | undefined) ?? "all",
    tags: args.tags as string[] | undefined,
  });

  const snapshot = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    description: n.description,
    state: n.state,
    priority: n.priority,
    tags: n.tags,
    transport: n.transport,
    subscriptions: brain.bus.getSubscriptions(n.id).map((s) => s.pattern),
  }));

  return Promise.resolve({ node_count: snapshot.length, nodes: snapshot });
}

function inspectNode(brain: BrainService, args: Record<string, unknown>): Promise<ToolResult> {
  const node = brain.instanceRegistry.get(args.node_id as string);
  if (!node) return Promise.resolve({ error: `Node not found: ${String(args.node_id)}` });

  return Promise.resolve({
    ...node,
    subscriptions: brain.bus.getSubscriptions(node.id),
  });
}

function findNodes(brain: BrainService, args: Record<string, unknown>): Promise<ToolResult> {
  if (args.query) {
    return Promise.resolve({ nodes: brain.instanceRegistry.find(args.query as string) });
  }
  return Promise.resolve({
    nodes: brain.instanceRegistry.list({
      tags: args.tags as string[] | undefined,
      state: args.state as NodeState | undefined,
    }),
  });
}

async function spawnNode(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  if (!args.type || !args.name) {
    return { error: "spawn_node requires 'type' and 'name'." };
  }

  // Normalize subscriptions — LLM may send strings, null, or objects
  let subscriptions: Array<{ topic: string }> | undefined;
  const rawSubs = args.subscriptions;
  if (Array.isArray(rawSubs) && rawSubs.length > 0) {
    subscriptions = rawSubs.map((s) =>
      typeof s === "string" ? { topic: s } : s as { topic: string },
    );
  } else if (rawSubs === null || rawSubs === undefined) {
    // No subscriptions — use type defaults (pass undefined, let the framework decide)
    subscriptions = undefined;
  }

  try {
    const node = await brain.spawnNode(
      {
        type: args.type as string,
        name: args.name as string,
        description: args.description as string | undefined,
        subscriptions,
        config_overrides: args.config_overrides as Record<string, unknown> | undefined,
      },
      callerNodeId,
    );
    log.info({ name: node.name, type: node.type }, "Brain spawned node");
    return { success: true, node_id: node.id, name: node.name, type: node.type };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Failed to spawn node: ${msg}`,
      hint: 'Subscriptions must be an array of objects: [{"topic": "some.topic"}]. Pass null or omit to use type defaults.',
      example: '{"type": "echo", "name": "my-echo", "subscriptions": [{"topic": "test.input"}]}',
    };
  }
}

function killNode(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const killed = brain.killNode(args.node_id as string, callerNodeId, args.reason as string | undefined);
  return Promise.resolve({ success: killed });
}

function stopNode(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const stopped = brain.stopNode(args.node_id as string, callerNodeId, args.reason as string | undefined);
  return Promise.resolve({ success: stopped });
}

async function startNode(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const started = await brain.startNode(args.node_id as string, callerNodeId, args.message as string | undefined);
  return { success: started };
}

function wakeNode(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const woken = brain.wakeNode(args.node_id as string, callerNodeId, args.message as string | undefined);
  return Promise.resolve({ success: woken });
}

function rewire(brain: BrainService, args: Record<string, unknown>): Promise<ToolResult> {
  const nodeId = args.node_id as string;
  const node = brain.instanceRegistry.get(nodeId);
  if (!node) return Promise.resolve({ error: `Node not found: ${nodeId}` });

  const addTopics = args.add_topics as string[] | undefined;
  const removeTopics = args.remove_topics as string[] | undefined;

  if (removeTopics) {
    for (const topic of removeTopics) {
      brain.bus.unsubscribe(nodeId, topic);
    }
  }
  if (addTopics) {
    for (const topic of addTopics) {
      brain.bus.subscribe(nodeId, topic);
    }
  }

  const current = brain.bus.getSubscriptions(nodeId).map((s) => s.pattern);
  log.info({ nodeId, subscriptions: current }, "Rewired node");
  return Promise.resolve({ success: true, subscriptions: current });
}

function publishMessage(
  brain: BrainService,
  args: Record<string, unknown>,
  callerNodeId: string,
): Promise<ToolResult> {
  const rawTopic = args.topic as string;
  const rawContent = args.content as string;

  if (!rawTopic || !rawContent) {
    return Promise.resolve({ error: "publish_message requires 'topic' and 'content'" });
  }

  const route = resolveRoute(rawTopic);

  // Validate: is any node listening on this topic?
  const listeners = brain.getNetworkSnapshot({ state: "all" })
    .filter((n) => n.id !== callerNodeId)
    .filter((n) => {
      const subs = brain.bus.getSubscriptions(n.id);
      return subs.some((s) => {
        if (s.pattern === route.topic) return true;
        if (s.pattern.endsWith(".*") && route.topic.startsWith(s.pattern.slice(0, -2))) return true;
        if (s.pattern === "*") return true;
        return false;
      });
    });

  if (listeners.length === 0) {
    // List available topics to help the brain self-correct
    const allTopics = new Set<string>();
    for (const n of brain.getNetworkSnapshot({ state: "all" })) {
      if (n.id === callerNodeId) continue;
      for (const s of brain.bus.getSubscriptions(n.id)) {
        allTopics.add(s.pattern);
      }
    }
    return Promise.resolve({
      error: `No node is listening on topic "${route.topic}". Message not delivered.`,
      available_topics: [...allTopics].sort(),
      hint: "Use one of the available_topics, or inspect_network() to see which nodes listen on what.",
    });
  }

  const msg = brain.bus.publish({
    from: callerNodeId,
    topic: route.topic,
    type: "text",
    criticality: (args.criticality as number | undefined) ?? 3,
    payload: { content: route.format(rawContent) },
  });

  const result: ToolResult = {
    success: true,
    message_id: msg.id,
    topic: route.topic,
    delivered_to: listeners.map((n) => n.name),
  };

  if (route.responseTopic && route.timeout > 0) {
    result.expects_response = { topic: route.responseTopic, timeout: route.timeout };
  }

  if (route.topic !== rawTopic) {
    result.note = `Topic aliased: "${rawTopic}" → "${route.topic}"`;
  }

  return Promise.resolve(result);
}

function getMessageHistory(brain: BrainService, args: Record<string, unknown>): Promise<ToolResult> {
  const messages = brain.bus.getMessageHistory({
    topic: args.topic as string | undefined,
    last: (args.last as number | undefined) ?? 20,
    min_criticality: args.min_criticality as number | undefined,
  });
  return Promise.resolve({
    messages: messages.map((m) => ({
      id: m.id,
      from: m.from,
      topic: m.topic,
      criticality: m.criticality,
      content: (m.payload as { content?: string }).content?.slice(0, 200),
      timestamp: m.timestamp,
    })),
  });
}

function listTypes(brain: BrainService): Promise<ToolResult> {
  const types = brain.typeRegistry.list();
  return Promise.resolve({
    types: types.map((t) => ({
      name: t.name,
      description: t.description,
      tags: t.tags,
    })),
  });
}

function think(args: Record<string, unknown>): Promise<ToolResult> {
  log.info({ thought: (args.thought as string).slice(0, 200) }, "Brain thinking");
  return Promise.resolve({ noted: true });
}
