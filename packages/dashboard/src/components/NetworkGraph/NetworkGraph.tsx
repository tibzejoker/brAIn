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
import type { NodeSnapshot } from "../../api/types";
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
  onNodeSelect: (id: string | null) => void;
  onEdgeSelect: (edge: EdgeSelection | null) => void;
  selectedNodeId: string | null;
}

const nodeTypes: NodeTypes = {
  brainNode: NodeBlock,
};

function snapshotToFlowNode(n: NodeSnapshot): Node {
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

function buildEdges(snapshots: NodeSnapshot[], flows: Flow[]): Edge[] {
  const edgeMap = new Map<string, { topics: Set<string>; active: boolean }>();

  // Track which flows are active (messages actually passing)
  const activeFlows = new Set<string>();
  for (const flow of flows) {
    activeFlows.add(`${flow.sourceId}->${flow.targetId}`);
  }

  // Build edges from subscriptions — match subscriber patterns against
  // other nodes' published topics (inferred from their type name or known outputs)
  for (const subscriber of snapshots) {
    for (const sub of subscriber.subscriptions) {
      for (const publisher of snapshots) {
        if (publisher.id === subscriber.id) continue;

        // Heuristic: a node likely publishes on topics matching its type or name
        const likelyTopics = [
          `${publisher.type}.*`,
          `${publisher.name}.*`,
          publisher.type,
          publisher.name,
        ];

        // Also check if the subscription pattern could match any topic from this publisher
        // by checking if the patterns overlap
        const connected =
          likelyTopics.some((t) => matchWildcard(sub.pattern, t)) ||
          matchWildcard(sub.pattern, `${publisher.type}.output`) ||
          matchWildcard(sub.pattern, `${publisher.type}.tick`);

        // Also connect if we've seen actual messages flow between them
        const flowKey = `${publisher.id}->${subscriber.id}`;
        const hasFlow = activeFlows.has(flowKey);

        if (connected || hasFlow) {
          const existing = edgeMap.get(flowKey);
          if (existing) {
            existing.topics.add(sub.pattern);
            if (hasFlow) existing.active = true;
          } else {
            edgeMap.set(flowKey, {
              topics: new Set([sub.pattern]),
              active: hasFlow,
            });
          }
        }
      }
    }
  }

  // Also add any flow-based edges not captured by subscription heuristics
  for (const flow of flows) {
    const key = `${flow.sourceId}->${flow.targetId}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        topics: new Set([flow.topic]),
        active: true,
      });
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
  onNodeSelect,
  onEdgeSelect,
  selectedNodeId,
}: NetworkGraphProps): React.ReactElement {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);

  // Sync snapshots into React Flow state
  useEffect(() => {
    setNodes((prev) => {
      // Build a map of current positions (from drag or previous state)
      const posMap = new Map(prev.map((n) => [n.id, n.position]));

      const newNodes = snapshots.map((snap) => {
        const flowNode = snapshotToFlowNode(snap);
        // Keep dragged position if it exists, otherwise use snapshot position
        const existing = posMap.get(snap.id);
        if (existing && (existing.x !== 0 || existing.y !== 0)) {
          flowNode.position = existing;
        }
        return flowNode;
      });

      // Auto-place nodes at {0,0}
      return layoutGraph(newNodes, []).nodes;
    });
  }, [snapshots, setNodes]);

  // Sync edges
  useEffect(() => {
    setEdges(buildEdges(snapshots, flows));
  }, [snapshots, flows, setEdges]);

  // Apply selection
  const displayNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId],
  );

  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node): void => {
    updateNodePosition(node.id, node.position.x, node.position.y).catch(() => {
      // best-effort
    });
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
