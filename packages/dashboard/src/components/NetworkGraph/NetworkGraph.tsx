import { useMemo, useCallback, useEffect, useRef, useState } from "react";
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
  type ReactFlowInstance,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { NodeSnapshot, NodeTypeConfig } from "../../api/types";
import { updateNodePosition, getAgents, type AgentSnapshot } from "../../api/client";
import { NodeBlock } from "./NodeBlock";
import { HostGroup } from "./HostGroup";
import { buildHostLayer, HOST_NODE_TYPE, sameRenderedShape } from "./host-layout";

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
  [HOST_NODE_TYPE]: HostGroup,
};

function snapshotToFlowNode(
  n: NodeSnapshot,
  typeMap: Map<string, NodeTypeConfig>,
  onOpenUi: (id: string) => void,
  onToggleExpand: (id: string) => void,
  onResizeExpanded: (id: string, w: number, h: number) => void,
  expandedNodeIds: Set<string>,
  expandedSizes: Map<string, { w: number; h: number }>,
  showCapabilityLayer: boolean,
  parentId: string | undefined,
  gridSlot: { x: number; y: number } | undefined,
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

  // When the node belongs to a host container, its position is RELATIVE to
  // that parent. The DB now stores those relative coords directly (drag-stop
  // persists them via `updateNodePosition`), so a non-zero stored position
  // is trusted as-is. Freshly-spawned nodes still arrive with (0, 0) — those
  // fall back to the grid slot computed by `buildHostLayer`.
  //
  // `expandParent: true` makes the parent grow automatically if the child is
  // dragged past the current border, rather than clamping the child like
  // `extent: "parent"` would.
  const hasStoredPos = n.position.x !== 0 || n.position.y !== 0;
  const position = parentId && !hasStoredPos && gridSlot
    ? gridSlot
    : { x: n.position.x, y: n.position.y };

  return {
    id: n.id,
    type: "brainNode",
    position,
    ...(parentId ? { parentId, expandParent: true } : {}),
    data: {
      label: n.name,
      nodeType: n.type,
      state: n.state,
      transport: n.transport,
      targetAgentId: (n as unknown as { target_agent_id?: string }).target_agent_id,
      tags: n.tags,
      hasUi: typeConfig?.has_ui ?? false,
      onOpenUi: () => { onOpenUi(n.id); },
      onToggleExpand: () => { onToggleExpand(n.id); },
      onResizeExpanded: (w: number, h: number) => { onResizeExpanded(n.id, w, h); },
      isExpanded: expandedNodeIds.has(n.id),
      expandedWidth: expandedSizes.get(n.id)?.w,
      expandedHeight: expandedSizes.get(n.id)?.h,
      subscribes,
      publishes,
      unreadCount: n.unread_count,
      authorityLevel: n.authority_level,
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
// Both relationships are drawn independently when they apply — control
// does NOT subsume inspect visually, because someone reading the graph
// wants to see "this node can inspect anyone reachable" as a distinct
// statement from "this node can control specific peers." So a ROOT
// hovering will show a cyan line to every other node (inspect-anyone)
// plus red lines to the subset it can also kill/stop.

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
  const hoveredAuth = hovered.authority_level;
  const edges: Edge[] = [];

  for (const other of snapshots) {
    if (other.id === hovered.id) continue;
    const otherAuth = other.authority_level;

    const pushEdge = (
      direction: "in" | "out",
      kind: "control" | "inspect",
      source: string,
      target: string,
    ): void => {
      edges.push({
        id: `auth:${direction}:${kind}:${source}->${target}`,
        source,
        target,
        sourceHandle: `auth-out-${kind}`,
        targetHandle: `auth-in-${kind}`,
        type: "smoothstep" as const,
        animated: true,
        style: {
          stroke: kind === "control" ? AUTH_CONTROL_COLOR : AUTH_INSPECT_COLOR,
          strokeWidth: AUTH_STROKE_WIDTH,
          opacity: AUTH_STROKE_OPACITY,
        },
      });
    };

    // Incoming to hovered: what can `other` do TO `hovered`?
    if (otherAuth >= 1) {
      pushEdge("in", "inspect", other.id, hovered.id);
      if (otherAuth > hoveredAuth) pushEdge("in", "control", other.id, hovered.id);
    }

    // Outgoing from hovered: what can `hovered` do TO `other`?
    if (hoveredAuth >= 1) {
      pushEdge("out", "inspect", hovered.id, other.id);
      if (hoveredAuth > otherAuth) pushEdge("out", "control", hovered.id, other.id);
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

// Edges that the static config doesn't predict but the bus has actually
// carried — e.g. a brain LLM publishing through its `publish_message`
// tool to `game.hangman.command`. These render in violet so they read
// as "they're connected because they've interacted" rather than
// "they're connected by config." Persistent across the session: a
// single past interaction is enough to keep the line drawn.
const DYNAMIC_EDGE_COLOR = "#a855f7";

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

  // Dynamic edges — any flow whose topic the publisher didn't declare
  // statically counts as a tool-call / dynamic publish. Drawn in violet,
  // dedup'd per (publisher, subscriber, topic). Static edges always win
  // (no double-line for the same pair on the same topic).
  const snapshotById = new Map(snapshots.map((n) => [n.id, n]));
  const dynamicSeen = new Set<string>();
  for (const flow of flows) {
    const publisher = snapshotById.get(flow.sourceId);
    const subscriber = snapshotById.get(flow.targetId);
    if (!publisher || !subscriber) continue;

    const declaredPublishes = inferPublishTopics(publisher, typeMap);
    // If the publisher declared this topic, the static loop above
    // already drew it (or skipped it because no subscriber pattern
    // matched). Either way, not a dynamic case.
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

  // Drag-in-progress flag — set on dragStart, cleared on dragStop. The
  // node-rebuild effect bails while this is true so a snapshot poll
  // landing mid-drag can't yank the node out from under the cursor.
  const isDraggingRef = useRef(false);

  // Auto fit-view runs ONCE — when nodes first appear after mount. The
  // built-in `fitView` prop only fits on the very first render, which
  // is too early (snapshots haven't arrived yet, the graph is empty).
  // We stash the React Flow instance from `onInit` and call fitView()
  // manually as soon as we have at least one node, then latch the flag
  // so subsequent polls don't re-zoom under the user.
  // ReactFlowInstance is generic over the node + edge types passed to
  // <ReactFlow>. We stash it via a `(...args: never[]) => void`-friendly
  // signature to dodge generic plumbing — we only use the .fitView() method
  // below, which is invariant across generic arguments.
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const hasFittedRef = useRef(false);
  const handleInit = useCallback((instance: unknown): void => {
    rfInstanceRef.current = instance as ReactFlowInstance;
  }, []);

  // Poll the agent list every 3 s so freshly-joined remotes (mobile app,
  // brain-agent) appear as host containers and disappear when their
  // announce window lapses (~30 s on the API side). Matches the cadence
  // of AgentsPanel so both views stay in sync.
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      getAgents()
        .then((list) => { if (!cancelled) setAgents(list); })
        .catch(() => { if (!cancelled) setAgents([]); });
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return (): void => { cancelled = true; clearInterval(interval); };
  }, []);

  // Capability layer state — persisted across sessions. When ON: nodes
  // sprout an authority chip + top/bottom handles, and hovering a node
  // reveals its incoming/outgoing authority edges.
  const [capabilityHoverEnabled, setCapabilityHoverEnabled] = useState<boolean>(loadCapabilityToggle);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // === In-place node UI expansion ==========================================
  // Any number of nodes may be expanded at once — each grows to a default
  // 480x360 panel that renders an `<iframe src="/nodes/:id/ui/">` and
  // exposes a NodeResizer handle on its right/bottom edges so the user
  // can drag it to whatever size suits the embedded UI. Per-node sizes
  // are kept in `expandedSizes` so collapsing then re-expanding restores
  // the last size. On mobile (<768px) we skip in-place expansion and
  // route straight to the fullscreen modal — a 480px-wide card has
  // nowhere to live on a phone viewport.
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const [expandedSizes, setExpandedSizes] = useState<Map<string, { w: number; h: number }>>(() => new Map());
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = (e: MediaQueryListEvent): void => { setIsMobile(e.matches); };
    // `addEventListener` is the modern API; Safari < 14 used
    // `addListener`. We only target evergreen browsers in the
    // dashboard, so the modern path is enough.
    mql.addEventListener("change", onChange);
    return () => { mql.removeEventListener("change", onChange); };
  }, []);

  const handleToggleExpand = useCallback((id: string): void => {
    // Mobile bypass: ignore in-place toggling, jump straight to the
    // fullscreen modal that App.tsx already owns.
    if (isMobile) {
      onOpenNodeUi(id);
      return;
    }
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [isMobile, onOpenNodeUi]);

  const handleResizeExpanded = useCallback((id: string, w: number, h: number): void => {
    setExpandedSizes((prev) => {
      const existing = prev.get(id);
      if (existing && existing.w === w && existing.h === h) return prev;
      const next = new Map(prev);
      next.set(id, { w, h });
      return next;
    });
  }, []);

  // If an expanded node disappears from the network (killed, renamed,
  // agent dropped) drop the orphan expansion state — otherwise a freshly-
  // spawned node with the same id would reappear pre-expanded.
  useEffect(() => {
    const live = new Set(snapshots.map((s) => s.id));
    setExpandedNodeIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) if (!live.has(id)) { next.delete(id); changed = true; }
      return changed ? next : prev;
    });
  }, [snapshots]);

  // Likewise, if the viewport crosses the mobile breakpoint while any
  // node is expanded in-place, collapse them all — the wide cards won't
  // fit and the user would just see clipped iframes.
  useEffect(() => {
    if (isMobile && expandedNodeIds.size > 0) setExpandedNodeIds(new Set());
  }, [isMobile, expandedNodeIds.size]);

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
      // 1. Bail during an in-flight drag — re-rendering the nodes array
      // mid-drag can drop the active drag context in React Flow. The next
      // snapshot poll after drag-stop runs this effect again normally.
      if (isDraggingRef.current) return prev;

      // 2. Capture each child's CURRENT React Flow position so a poll
      // arriving between drag-stop and the API save doesn't bounce the
      // node back to its pre-drag coords. Only sticky as long as the
      // node is still in the same parent (host change resets to snapshot).
      const prevState = new Map<string, { x: number; y: number; parentId?: string }>();
      for (const n of prev) {
        if (n.type === HOST_NODE_TYPE) continue;
        prevState.set(n.id, {
          x: n.position.x,
          y: n.position.y,
          parentId: (n as { parentId?: string }).parentId,
        });
      }

      const { hostNodes, parentIdOf, gridSlotOf } = buildHostLayer(snapshots, agents);

      const childNodes = snapshots.map((snap) => {
        const newParent = parentIdOf.get(snap.id);
        const flowNode = snapshotToFlowNode(
          snap,
          typeMap,
          onOpenNodeUi,
          handleToggleExpand,
          handleResizeExpanded,
          expandedNodeIds,
          expandedSizes,
          capabilityHoverEnabled,
          newParent,
          gridSlotOf.get(snap.id),
        );
        const ps = prevState.get(snap.id);
        if (ps && ps.parentId === newParent) {
          flowNode.position = { x: ps.x, y: ps.y };
        }
        return flowNode;
      });

      // React Flow requires parent nodes to come BEFORE their children.
      const next = [...hostNodes, ...childNodes];

      // 3. Skip the re-render if nothing meaningful changed since last
      // time. Polls fire every 1–3 s; without this check, every poll
      // would rebuild + re-render the whole graph even when the snapshot
      // is identical to the previous one. We compare a compact fingerprint
      // of the fields that actually affect rendering — positions are
      // excluded because they're sticky-overridden above anyway.
      return sameRenderedShape(prev, next) ? prev : next;
    });
  }, [snapshots, agents, typeMap, onOpenNodeUi, handleToggleExpand, handleResizeExpanded, expandedNodeIds, expandedSizes, setNodes, capabilityHoverEnabled]);

  useEffect(() => {
    const pubSub = buildEdges(snapshots, flows, types);
    const auth = capabilityHoverEnabled ? buildAuthorityEdges(hoveredNodeId, snapshots) : [];
    setEdges([...pubSub, ...auth]);
  }, [snapshots, flows, types, setEdges, capabilityHoverEnabled, hoveredNodeId]);

  // First-paint auto fit-view. Fires once, the moment the React Flow
  // instance is ready AND there's at least one node to frame. After
  // that the latch flips and subsequent polls leave the user's zoom +
  // pan alone.
  useEffect(() => {
    if (hasFittedRef.current) return;
    if (!rfInstanceRef.current) return;
    if (nodes.length === 0) return;
    // Defer one tick so React Flow has finished measuring the freshly-
    // mounted nodes — fitView before measurement gives a stale viewport.
    const t = setTimeout(() => {
      void rfInstanceRef.current?.fitView({ padding: 0.1, duration: 300 });
      hasFittedRef.current = true;
    }, 50);
    return (): void => { clearTimeout(t); };
  }, [nodes.length]);

  const displayNodes = useMemo(
    () => nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: { ...n.data, isHovered: n.id === hoveredNodeId },
    })),
    [nodes, selectedNodeId, hoveredNodeId],
  );

  const handleNodeDragStart = useCallback((): void => {
    isDraggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node): void => {
    isDraggingRef.current = false;
    // Host containers are synthetic — rebuilt from agents/snapshots every
    // poll — so we never persist their drag position.
    if (node.type === HOST_NODE_TYPE) return;
    // For child nodes the position is now RELATIVE to its parent. We persist
    // those relative coords directly; on next load, snapshotToFlowNode treats
    // them as relative when the snapshot still has a parent. If the host
    // layer is ever disabled, the existing absolute-vs-relative meaning
    // would need a migration — flagged in the host-layout.ts header.
    updateNodePosition(node.id, node.position.x, node.position.y).catch(noop);
  }, []);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      // Hosts are visual-only — clicking the container shouldn't open a
      // NodePanel meant for an actual brain node.
      if (node.type === HOST_NODE_TYPE) return;
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
      onNodeDragStart={handleNodeDragStart}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={handleNodeMouseEnter}
      onNodeMouseLeave={handleNodeMouseLeave}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      onInit={handleInit}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
      <Controls>
        <ControlButton
          onClick={() => { setCapabilityHoverEnabled((v) => !v); }}
          title={`${capabilityHoverEnabled ? "Hide" : "Show"} authority overlay (C). Hover a node to see who can control/inspect it.`}
          style={capabilityHoverEnabled ? { background: "var(--color-accent)", color: "var(--color-accent-fg)" } : undefined}
        >
          <span className="text-[10px] font-bold tracking-tight">CAP</span>
        </ControlButton>
      </Controls>
      <MiniMap
        nodeStrokeWidth={2}
        nodeColor={(n) => {
          // Mirror the --color-node-* tokens in app.css. Minimap is
          // canvas-only, so it can't read CSS vars via Tailwind classes
          // and we have to inline the hex values — keep these in sync
          // with the @theme block.
          const state = n.data.state;
          if (state === "active") return "#4ade80";
          if (state === "sleeping") return "#fbbf24";
          if (state === "stopped") return "#f84e4e";
          return "#707070";
        }}
      />
    </ReactFlow>
  );
}
