import { useMemo, useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeMouseHandler,
  type NodeTypes,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { NodeSnapshot, NodeTypeConfig } from "../../api/types";
import { updateNodePosition } from "../../api/client";
import { NodeBlock } from "./NodeBlock";
import { layoutGraph } from "./graph-layout";

interface Flow {
  sourceId: string;
  targetId: string;
  topic: string;
  count: number;
}

export interface EdgeSelection {
  sourceId: string;
  targetId: string;
  topics: string[];
}

interface NetworkGraphProps {
  nodes: NodeSnapshot[];
  flows: Flow[];
  types: NodeTypeConfig[];
  onNodeSelect: (id: string | null) => void;
  onEdgeSelect: (edge: EdgeSelection | null) => void;
  onOpenNodeUi: (nodeId: string) => void;
  selectedNodeId: string | null;
}

function noop(): void { /* best-effort */ }

const nodeTypes: NodeTypes = {
  brainNode: NodeBlock,
};

function snapshotToFlowNode(
  n: NodeSnapshot,
  typeMap: Map<string, NodeTypeConfig>,
  onOpenUi: (id: string) => void,
): Node {
  const typeConfig = typeMap.get(n.type);
  return {
    id: n.id,
    type: "brainNode",
    position: { x: n.position.x, y: n.position.y },
    data: {
      label: n.name,
      nodeType: n.type,
      state: n.state,
      transport: n.transport,
      tags: n.tags,
      hasUi: typeConfig?.has_ui ?? false,
      onOpenUi: () => { onOpenUi(n.id); },
    },
  };
}

function matchWildcard(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/**
 * Infer what topics a node likely publishes on, based on:
 * - config_overrides.response_topic / topic
 * - Known patterns: echo publishes on echo.output, cron publishes its configured topic, etc.
 * - Node type defaults
 */
/**
 * Infer what topics a node publishes on.
 * Sources (in priority order):
 *   1. config_overrides.response_topic / topic (instance-level override)
 *   2. default_publishes from the node type config
 * Purely data-driven — no hardcoded types.
 */
function inferPublishTopics(n: NodeSnapshot, typeMap: Map<string, NodeTypeConfig>): string[] {
  const topics: string[] = [];
  const co = n.config_overrides ?? {} as Record<string, unknown>;

  // Instance-level overrides take priority
  if (typeof co.response_topic === "string") topics.push(co.response_topic);
  if (typeof co.topic === "string") topics.push(co.topic);

  // Fall back to type defaults
  if (topics.length === 0) {
    const typeConfig = typeMap.get(n.type);
    if (typeConfig?.default_publishes) {
      topics.push(...typeConfig.default_publishes);
    }
  }

  return topics;
}

function buildEdges(snapshots: NodeSnapshot[], flows: Flow[], types: NodeTypeConfig[]): Edge[] {
  const typeMap = new Map(types.map((t) => [t.name, t]));
  const edgeMap = new Map<string, { topics: Set<string>; active: boolean }>();

  // Active flows from real messages
  const activeFlows = new Map<string, Set<string>>();
  for (const flow of flows) {
    const key = `${flow.sourceId}->${flow.targetId}`;
    const existing = activeFlows.get(key);
    if (existing) {
      existing.add(flow.topic);
    } else {
      activeFlows.set(key, new Set([flow.topic]));
    }
  }

  // Match inferred publish topics against subscriptions
  for (const publisher of snapshots) {
    const pubTopics = inferPublishTopics(publisher, typeMap);
    if (pubTopics.length === 0) continue;

    for (const subscriber of snapshots) {
      if (subscriber.id === publisher.id) continue;

      const matchedPatterns = new Set<string>();
      for (const sub of subscriber.subscriptions) {
        for (const pubTopic of pubTopics) {
          if (matchWildcard(sub.pattern, pubTopic)) {
            matchedPatterns.add(sub.pattern);
          }
        }
      }

      if (matchedPatterns.size > 0) {
        const key = `${publisher.id}->${subscriber.id}`;
        const flowTopics = activeFlows.get(key);
        edgeMap.set(key, {
          topics: matchedPatterns,
          active: flowTopics !== undefined && flowTopics.size > 0,
        });
      }
    }
  }

  // Add any flow-based edges not captured by inference
  for (const [key, topics] of activeFlows) {
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { topics, active: true });
    }
  }

  return Array.from(edgeMap.entries()).map(([key, { topics, active }]) => {
    const [source, target] = key.split("->");
    return {
      id: key,
      source,
      target,
      label: Array.from(topics).join(", "),
      animated: active,
      style: {
        stroke: active ? "var(--color-accent)" : "var(--color-border-bright)",
        strokeWidth: active ? 2 : 1,
        strokeDasharray: active ? undefined : "5 5",
      },
      labelStyle: { fill: "var(--color-text-muted)", fontSize: 10 },
    };
  });
}

export function NetworkGraph({
  nodes: snapshots,
  flows,
  types,
  onNodeSelect,
  onEdgeSelect,
  onOpenNodeUi,
  selectedNodeId,
}: NetworkGraphProps): React.ReactElement {
  const typeMap = useMemo(() => new Map(types.map((t) => [t.name, t])), [types]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);

  useEffect(() => {
    setNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]));
      const newNodes = snapshots.map((snap) => {
        const flowNode = snapshotToFlowNode(snap, typeMap, onOpenNodeUi);
        const existing = posMap.get(snap.id);
        if (existing && (existing.x !== 0 || existing.y !== 0)) {
          flowNode.position = existing;
        }
        return flowNode;
      });
      return layoutGraph(newNodes, []).nodes;
    });
  }, [snapshots, typeMap, onOpenNodeUi, setNodes]);

  useEffect(() => {
    setEdges(buildEdges(snapshots, flows, types));
  }, [snapshots, flows, types, setEdges]);

  const displayNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId],
  );

  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node): void => {
    updateNodePosition(node.id, node.position.x, node.position.y).catch(noop);
  }, []);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      onNodeSelect(node.id === selectedNodeId ? null : node.id);
    },
    [onNodeSelect, selectedNodeId],
  );

  const handleEdgeClick: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      const [source, target] = edge.id.split("->");
      const topics = typeof edge.label === "string" ? edge.label.split(", ") : [];
      onEdgeSelect({ sourceId: source, targetId: target, topics });
    },
    [onEdgeSelect],
  );

  const handlePaneClick = useCallback((): void => {
    onNodeSelect(null);
    onEdgeSelect(null);
  }, [onNodeSelect, onEdgeSelect]);

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
      <Controls />
      <MiniMap
        nodeStrokeWidth={2}
        nodeColor={(n) => {
          const state = n.data.state;
          if (state === "active") return "#22c55e";
          if (state === "sleeping") return "#f59e0b";
          if (state === "stopped") return "#ef4444";
          return "#6b7280";
        }}
      />
    </ReactFlow>
  );
}
