import type { Edge } from "@xyflow/react";
import type { NodeSnapshot, NodeTypeConfig } from "../../api/types";

/** Minimal message-flow shape buildEdges needs (structurally compatible
 *  with the dashboard's Flow). */
export interface EdgeFlow {
  sourceId: string;
  targetId: string;
  topic: string;
  lastSeen: number;
}

function topicColor(topic: string): string {
  let hash = 0;
  for (let i = 0; i < topic.length; i++) {
    hash = topic.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 70%, 65%)`;
}

function matchWildcard(pattern: string | undefined | null, topic: string | undefined | null): boolean {
  // Defensive: a transient malformed snapshot (e.g. just-spawned node
  // with subscriptions still being wired) can hand us undefined here.
  // Returning false instead of crashing keeps the whole dashboard up
  // — the missed edge re-appears on the next snapshot poll.
  if (!pattern || !topic) return false;
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/**
 * Infer what topics a node publishes on.
 * Sources (in priority order):
 *   1. config_overrides.response_topic / topic (instance-level override)
 *   2. default_publishes from the node type config
 * Purely data-driven — no hardcoded types.
 */
export function inferPublishTopics(n: NodeSnapshot, typeMap: Map<string, NodeTypeConfig>): string[] {
  const topics = new Set<string>();
  const co = n.config_overrides ?? {};

  if (typeof co.response_topic === "string") topics.add(co.response_topic);
  if (typeof co.topic === "string") topics.add(co.topic);

  const typeConfig = typeMap.get(n.type);
  if (typeConfig?.default_publishes) {
    for (const t of typeConfig.default_publishes) topics.add(t);
  }

  return [...topics];
}

// Edges that the static config doesn't predict but the bus has actually
// carried — e.g. a brain LLM publishing through its `publish_message`
// tool to `game.hangman.command`. These render in violet so they read
// as "they're connected because they've interacted". Persistent across
// the session: a single past interaction is enough to keep the line drawn.
const DYNAMIC_EDGE_COLOR = "#a855f7";

export function buildEdges(snapshots: NodeSnapshot[], flows: EdgeFlow[], types: NodeTypeConfig[]): Edge[] {
  const typeMap = new Map(types.map((t) => [t.name, t]));
  const edges: Edge[] = [];
  const seen = new Set<string>();

  // Active flow pairs — only if last message was within 3 seconds
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 3000;
  const activeFlows = new Set<string>();
  for (const flow of flows) {
    if (now - flow.lastSeen < ACTIVE_THRESHOLD_MS) {
      activeFlows.add(`${flow.sourceId}->${flow.targetId}`);
    }
  }

  // For each publisher, match its publish topics to subscriber patterns
  for (const publisher of snapshots) {
    const pubTopics = inferPublishTopics(publisher, typeMap);

    for (const pubTopic of pubTopics) {
      for (const subscriber of snapshots) {
        if (subscriber.id === publisher.id) continue;

        for (const sub of subscriber.subscriptions) {
          if (!matchWildcard(sub.pattern, pubTopic)) continue;

          const edgeId = `${publisher.id}:${pubTopic}->${subscriber.id}:${sub.pattern}`;
          if (seen.has(edgeId)) continue;
          seen.add(edgeId);

          const active = activeFlows.has(`${publisher.id}->${subscriber.id}`);
          const color = topicColor(pubTopic);

          edges.push({
            id: edgeId,
            source: publisher.id,
            target: subscriber.id,
            sourceHandle: `out-${pubTopic}`,
            targetHandle: `in-${sub.pattern}`,
            type: "smoothstep" as const,
            animated: active,
            style: {
              stroke: color,
              strokeWidth: active ? 2 : 1,
              strokeDasharray: active ? undefined : "5 5",
              opacity: active ? 1 : 0.5,
            },
          });
        }
      }
    }
  }

  // Dynamic edges — any flow whose topic the publisher didn't declare
  // statically counts as a tool-call / dynamic publish. Drawn in violet,
  // dedup'd per (publisher, subscriber, topic). Static edges always win.
  const snapshotById = new Map(snapshots.map((n) => [n.id, n]));
  const dynamicSeen = new Set<string>();
  for (const flow of flows) {
    const publisher = snapshotById.get(flow.sourceId);
    const subscriber = snapshotById.get(flow.targetId);
    if (!publisher || !subscriber) continue;

    const declaredPublishes = inferPublishTopics(publisher, typeMap);
    if (declaredPublishes.includes(flow.topic)) continue;

    const dynamicId = `dyn:${publisher.id}:${flow.topic}->${subscriber.id}`;
    if (dynamicSeen.has(dynamicId)) continue;
    dynamicSeen.add(dynamicId);

    const active = activeFlows.has(`${publisher.id}->${subscriber.id}`);
    edges.push({
      id: dynamicId,
      source: publisher.id,
      target: subscriber.id,
      sourceHandle: "out-default",
      targetHandle: "in-default",
      type: "smoothstep" as const,
      animated: active,
      style: {
        stroke: DYNAMIC_EDGE_COLOR,
        strokeWidth: active ? 2 : 1.5,
        strokeDasharray: "3 3",
        opacity: active ? 1 : 0.7,
      },
      label: flow.topic,
      labelStyle: { fill: DYNAMIC_EDGE_COLOR, fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "var(--color-surface-overlay, #1f2937)" },
      labelBgPadding: [4, 2],
    });
  }

  return edges;
}
