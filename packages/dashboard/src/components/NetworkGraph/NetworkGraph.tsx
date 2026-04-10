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

function buildEdges(snapshots: NodeSnapshot[], flows: Flow[]): Edge[] {
  const edgeMap = new Map<string, { topics: Set<string>; animated: boolean }>();
  const nodeIds = new Set(snapshots.map((n) => n.id));

  for (const flow of flows) {
    if (!nodeIds.has(flow.sourceId) || !nodeIds.has(flow.targetId)) continue;

    const key = `${flow.sourceId}->${flow.targetId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.topics.add(flow.topic);
    } else {
      const targetNode = snapshots.find((n) => n.id === flow.targetId);
      edgeMap.set(key, {
        topics: new Set([flow.topic]),
        animated: targetNode?.state === "active",
      });
    }
  }

  return Array.from(edgeMap.entries()).map(([key, { topics, animated }]) => {
    const [source, target] = key.split("->");
    return {
      id: key,
      source,
      target,
      label: Array.from(topics).join(", "),
      animated,
      style: { stroke: "var(--color-border-bright)", strokeWidth: 2 },
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
