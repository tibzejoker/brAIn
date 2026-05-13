import { useMemo, useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
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
  lastSeen: number;
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
  showCapabilityLayer: boolean,
): Node {
  const typeConfig = typeMap.get(n.type);

  // Resolve all publish topics (instance overrides + type defaults)
  const publishes = inferPublishTopics(n, typeMap);

  // Subscriptions — fall back to `topic` if `pattern` is absent (some
  // event payloads ship the raw SubscriptionConfig before the API gets
  // a chance to reshape). Filter out anything still falsy so
  // topicColor() never receives undefined.
  const subscribes = (n.subscriptions as Array<{ pattern?: string; topic?: string }>)
    .map((s) => s.pattern ?? s.topic ?? "")
    .filter((t) => t.length > 0);

  return {
    id: n.id,
    type: "brainNode",
    position: { x: n.position.x, y: n.position.y },
    data: {
      label: n.name,
      nodeType: n.type,
      state: n.state,
      transport: n.transport,
      targetAgentId: (n as unknown as { target_agent_id?: string }).target_agent_id,
      tags: n.tags,
      hasUi: typeConfig?.has_ui ?? false,
      onOpenUi: () => { onOpenUi(n.id); },
      subscribes,
      publishes,
      unreadCount: n.unread_count ?? 0,
      authorityLevel: n.authority_level ?? 0,
      showCapabilityLayer,
      // Hover is patched in by the `displayNodes` memo below so this
      // heavy build effect doesn't re-run on every mouse-over.
      isHovered: false,
    },
  };
}

// === Authority (capability) overlay ===========================================
//
// Authority is not bus traffic — it's a per-call permission check on the
// framework's AuthorityService. The overlay below draws it as a SEPARATE
// edge layer on top of the pub/sub graph, only when the user toggles the
// capability layer ON and is hovering a node. See AuthorityService for
// the source-of-truth rules; we mirror them here for visualisation:
//
//   - Y can CONTROL X (kill/stop/start/wake/rewire) iff Y.authority_level
//     > X.authority_level  AND  Y.authority_level >= 1.
//   - Y can INSPECT X (read-only network/node introspection) iff
//     Y.authority_level >= 1.
//
// We only draw the strongest relationship per pair — control implies
// inspect, so a single red line is enough.

const AUTH_CONTROL_COLOR = "#dc2626"; // strong red — kill/stop/rewire
const AUTH_INSPECT_COLOR = "#0891b2"; // strong cyan — read-only
const AUTH_STROKE_WIDTH = 3;
// Edges are animated (flowing dashes) so direction is unambiguous;
// opacity is dropped so they don't fight the pub/sub layer on hover.
const AUTH_STROKE_OPACITY = 0.55;

function buildAuthorityEdges(hoveredId: string | null, snapshots: NodeSnapshot[]): Edge[] {
  if (!hoveredId) return [];
  const hovered = snapshots.find((n) => n.id === hoveredId);
  if (!hovered) return [];
  const hoveredAuth = hovered.authority_level ?? 0;
  const edges: Edge[] = [];

  for (const other of snapshots) {
    if (other.id === hovered.id) continue;
    const otherAuth = other.authority_level ?? 0;

    // Incoming to hovered: what can `other` do TO `hovered`?
    if (otherAuth >= 1) {
      const isControl = otherAuth > hoveredAuth;
      const kind = isControl ? "control" : "inspect";
      edges.push({
        id: `auth:in:${kind}:${other.id}->${hovered.id}`,
        source: other.id,
        target: hovered.id,
        sourceHandle: `auth-out-${kind}`,
        targetHandle: `auth-in-${kind}`,
        type: "smoothstep" as const,
        animated: true,
        style: {
          stroke: isControl ? AUTH_CONTROL_COLOR : AUTH_INSPECT_COLOR,
          strokeWidth: AUTH_STROKE_WIDTH,
          opacity: AUTH_STROKE_OPACITY,
        },
      });
    }

    // Outgoing from hovered: what can `hovered` do TO `other`?
    if (hoveredAuth >= 1) {
      const isControl = hoveredAuth > otherAuth;
      const kind = isControl ? "control" : "inspect";
      edges.push({
        id: `auth:out:${kind}:${hovered.id}->${other.id}`,
        source: hovered.id,
        target: other.id,
        sourceHandle: `auth-out-${kind}`,
        targetHandle: `auth-in-${kind}`,
        type: "smoothstep" as const,
        animated: true,
        style: {
          stroke: isControl ? AUTH_CONTROL_COLOR : AUTH_INSPECT_COLOR,
          strokeWidth: AUTH_STROKE_WIDTH,
          opacity: AUTH_STROKE_OPACITY,
        },
      });
    }
  }

  return edges;
}

const CAPABILITY_TOGGLE_KEY = "brain.dashboard.capabilityHoverEnabled";

function loadCapabilityToggle(): boolean {
  try {
    return window.localStorage.getItem(CAPABILITY_TOGGLE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistCapabilityToggle(enabled: boolean): void {
  try {
    window.localStorage.setItem(CAPABILITY_TOGGLE_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage can be blocked in private mode / sandboxed iframes —
    // we lose persistence but the in-session toggle still works.
  }
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
  const topics = new Set<string>();
  const co = n.config_overrides ?? {} as Record<string, unknown>;

  // Instance-level overrides
  if (typeof co.response_topic === "string") topics.add(co.response_topic);
  if (typeof co.topic === "string") topics.add(co.topic);

  // Type defaults — always included (a node can publish to its response topic AND route to other services)
  const typeConfig = typeMap.get(n.type);
  if (typeConfig?.default_publishes) {
    for (const t of typeConfig.default_publishes) topics.add(t);
  }

  return [...topics];
}

function buildEdges(snapshots: NodeSnapshot[], flows: Flow[], types: NodeTypeConfig[]): Edge[] {
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

  return edges;
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

  // Capability layer state — persisted across sessions. When ON: nodes
  // sprout an authority chip + top/bottom handles, and hovering a node
  // reveals its incoming/outgoing authority edges.
  const [capabilityHoverEnabled, setCapabilityHoverEnabled] = useState<boolean>(loadCapabilityToggle);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  useEffect(() => { persistCapabilityToggle(capabilityHoverEnabled); }, [capabilityHoverEnabled]);

  // Press `C` to toggle the capability layer. Skip when the user is
  // typing in an input/textarea/contenteditable so it doesn't fight with
  // text entry anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      setCapabilityHoverEnabled((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

  useEffect(() => {
    setNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]));
      const newNodes = snapshots.map((snap) => {
        const flowNode = snapshotToFlowNode(snap, typeMap, onOpenNodeUi, capabilityHoverEnabled);
        // Preserve existing positions — only layout truly new nodes
        const existing = posMap.get(snap.id);
        if (existing && (existing.x !== 0 || existing.y !== 0)) {
          flowNode.position = existing;
        }
        return flowNode;
      });
      // Only run layout for nodes that still need placement (position 0,0)
      const needsLayout = newNodes.some((n) => n.position.x === 0 && n.position.y === 0);
      return needsLayout ? layoutGraph(newNodes, []).nodes : newNodes;
    });
  }, [snapshots, typeMap, onOpenNodeUi, setNodes, capabilityHoverEnabled]);

  useEffect(() => {
    const pubSub = buildEdges(snapshots, flows, types);
    const auth = capabilityHoverEnabled ? buildAuthorityEdges(hoveredNodeId, snapshots) : [];
    setEdges([...pubSub, ...auth]);
  }, [snapshots, flows, types, setEdges, capabilityHoverEnabled, hoveredNodeId]);

  const displayNodes = useMemo(
    () => nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: { ...n.data, isHovered: n.id === hoveredNodeId },
    })),
    [nodes, selectedNodeId, hoveredNodeId],
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
      // Edge ID format: "publisherId:topic->subscriberId:pattern"
      const [sourcePart, targetPart] = edge.id.split("->");
      const sourceId = sourcePart.split(":")[0];
      const targetId = targetPart.split(":")[0];
      const topic = sourcePart.split(":").slice(1).join(":");
      onEdgeSelect({ sourceId, targetId, topics: [topic] });
    },
    [onEdgeSelect],
  );

  const handlePaneClick = useCallback((): void => {
    onNodeSelect(null);
    onEdgeSelect(null);
  }, [onNodeSelect, onEdgeSelect]);

  // Track hovered node only when the capability layer is on — otherwise
  // we'd be re-rendering the edges array on every mouse-over for no gain.
  const handleNodeMouseEnter: NodeMouseHandler = useCallback((_event, node) => {
    if (!capabilityHoverEnabled) return;
    setHoveredNodeId(node.id);
  }, [capabilityHoverEnabled]);

  const handleNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    if (!capabilityHoverEnabled) return;
    setHoveredNodeId(null);
  }, [capabilityHoverEnabled]);

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={handleNodeMouseEnter}
      onNodeMouseLeave={handleNodeMouseLeave}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
      <Controls>
        <ControlButton
          onClick={() => { setCapabilityHoverEnabled((v) => !v); }}
          title={`${capabilityHoverEnabled ? "Hide" : "Show"} authority overlay (C). Hover a node to see who can control/inspect it.`}
          style={capabilityHoverEnabled ? { background: "var(--color-accent, #2563eb)", color: "white" } : undefined}
        >
          <span className="text-[10px] font-bold tracking-tight">CAP</span>
        </ControlButton>
      </Controls>
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
