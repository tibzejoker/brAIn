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
import type { NodeSnapshot, NodeTypeConfig, CursorUpdate } from "../../api/types";
import { getAgents, getTransport, type AgentSnapshot } from "../../api/client";
import { emitLayoutUpdate, emitCursorUpdate, emitHostLayout, onLayoutUpdate, onCursorUpdate, onHostLayout, onAgentAnnounced, onAgentExpired } from "../../api/socket";
import { getSelfHubId } from "../../api/request";
import { RemoteCursors } from "./RemoteCursors";
import { NodeBlock } from "./NodeBlock";
import { HostGroup } from "./HostGroup";
import { buildHostLayer, fitHostsToChildren, HOST_NODE_TYPE, HOST_ID_LOCAL, HOST_PREFIX_AGENT, sameRenderedShape } from "./host-layout";
import { buildEdges, inferPublishTopics } from "./graph-edges";
import { buildAuthorityEdges } from "./authority-edges";

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
  // Collaborative layout + presence: which node we're dragging (so an
  // incoming move for it doesn't fight us), and throttle clocks for the
  // ~10/s outbound layout + cursor broadcasts.
  const draggingIdRef = useRef<string | null>(null);
  const lastLayoutSentRef = useRef(0);
  const lastCursorSentRef = useRef(0);
  const [cursors, setCursors] = useState<CursorUpdate[]>([]);
  // Our own machine-container position. Fetched from transport (async, hence
  // state so the layout re-runs once it lands — local nodes carry no
  // owner_hub, so this is the only source for our block's placement) and
  // updated optimistically when we (or a peer) move our block.
  const [selfCanvasPos, setSelfCanvasPos] = useState<{ x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    void getTransport().then((t) => { if (t.canvas_pos) setSelfCanvasPos(t.canvas_pos); }).catch(() => { /* offline */ });
  }, []);
  // Optimistic container positions, keyed by host id. Set the instant we
  // drag a block (local OR a peer's) and updated by incoming host:layout, so
  // the dropped position holds immediately instead of snapping back to the
  // stale snapshot value until the ~3s round-trip lands. Authoritative over
  // the snapshot/transport seed.
  const [hostOverrides, setHostOverrides] = useState<Record<string, { x: number; y: number }>>({});

  // Bumped on drag-stop to force the rebuild effect to re-run, which is where
  // the four-side "hug" (origin slide) happens. Without this trigger the hug
  // would wait for the next snapshot/agent socket event, which may never come.
  const [layoutTick, setLayoutTick] = useState(0);

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

  // Agent host containers, driven in real time by the socket — no polling.
  // We seed once with getAgents() (so an agent that announced before this
  // client connected still shows up) then let `agent:announced` /
  // `agent:expired` upsert/remove entries as they arrive. The API emits an
  // announce on every refresh, so a changing `types` set (passive→active)
  // also propagates live.
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  useEffect(() => {
    let cancelled = false;
    getAgents()
      .then((list) => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });

    const upsert = (agent: AgentSnapshot): void => {
      setAgents((prev) => {
        const i = prev.findIndex((a) => a.agent_id === agent.agent_id);
        if (i === -1) return [...prev, agent];
        // Skip churn on plain refreshes — only re-render when something the
        // graph actually draws (host label, installable types) changed.
        const cur = prev[i];
        const sameTypes = cur.types.length === agent.types.length
          && cur.types.every((t, k) => t === agent.types[k]);
        if (cur.host === agent.host && sameTypes) return prev;
        const next = prev.slice();
        next[i] = agent;
        return next;
      });
    };
    const remove = (agent: AgentSnapshot): void => {
      setAgents((prev) => prev.filter((a) => a.agent_id !== agent.agent_id));
    };

    const unsubs = [onAgentAnnounced(upsert), onAgentExpired(remove)];
    return (): void => { cancelled = true; for (const u of unsubs) u(); };
  }, []);

  // Capability layer state — persisted across sessions. When ON: nodes
  // sprout an authority chip + top/bottom handles, and hovering a node
  // reveals its incoming/outgoing authority edges.
  const [capabilityHoverEnabled, setCapabilityHoverEnabled] = useState<boolean>(loadCapabilityToggle);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // === In-place node UI expansion ==========================================
  // Any number of nodes may be expanded at once — each grows to a default
  // 480x360 panel that renders an `<iframe src="/node/:id/ui/">` and
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
      // Host origins are preserved across rebuilds too: `fitHostsToChildren`
      // slides a host's origin inward to hug its content, but buildHostLayer
      // always re-emits it at the row-layout cursor — without carrying the
      // previous origin forward, that slide is undone every rebuild and the
      // content visibly jumps back. Row-layout x is only the *initial* slot.
      const prevHostPos = new Map<string, { x: number; y: number }>();
      for (const n of prev) {
        if (n.type === HOST_NODE_TYPE) {
          prevHostPos.set(n.id, { x: n.position.x, y: n.position.y });
          continue;
        }
        prevState.set(n.id, {
          x: n.position.x,
          y: n.position.y,
          parentId: (n as { parentId?: string }).parentId,
        });
      }

      // Synced container positions: our own from transport (local nodes have
      // no owner_hub), peers' from their snapshot's owner_hub.canvas_pos. Used
      // on first render / reload; live moves come via onHostLayout below.
      const canvasPosByHost = new Map<string, { x: number; y: number }>();
      if (selfCanvasPos) canvasPosByHost.set(HOST_ID_LOCAL, selfCanvasPos);
      for (const s of snapshots) {
        const oh = s.owner_hub;
        if (oh?.canvas_pos) canvasPosByHost.set(`${HOST_PREFIX_AGENT}${oh.hub_id}`, oh.canvas_pos);
      }
      // Optimistic overrides win over the snapshot seed (no snap-back on drop).
      for (const [id, p] of Object.entries(hostOverrides)) canvasPosByHost.set(id, p);
      const { hostNodes, parentIdOf, gridSlotOf } = buildHostLayer(snapshots, agents, canvasPosByHost);
      for (const h of hostNodes) {
        // A synced canvas position is authoritative — don't let a stale
        // prevHostPos (e.g. the default placement captured before transport
        // resolved on reload) clobber it.
        if (canvasPosByHost.has(h.id)) continue;
        const pos = prevHostPos.get(h.id);
        if (pos) h.position = pos;
      }

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

      // Shrink/grow each host to wrap its children's current positions, hugging
      // all four sides. Done here (not in buildHostLayer) because it needs the
      // sticky-resolved positions just applied above.
      fitHostsToChildren(hostNodes, childNodes, expandedSizes);

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
  }, [snapshots, agents, typeMap, onOpenNodeUi, handleToggleExpand, handleResizeExpanded, expandedNodeIds, expandedSizes, setNodes, capabilityHoverEnabled, layoutTick, selfCanvasPos, hostOverrides]);

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

  const handleNodeDragStart = useCallback((_event: React.MouseEvent, node: Node): void => {
    isDraggingRef.current = true;
    draggingIdRef.current = node.id;
  }, []);

  // Live position broadcast while dragging, throttled to ~10/s so the move
  // animates on every other open view without flooding the bus. The durable
  // persist happens once on drag-stop.
  const handleNodeDrag = useCallback((_event: React.MouseEvent, node: Node): void => {
    if (node.type === HOST_NODE_TYPE) return;
    const now = Date.now();
    if (now - lastLayoutSentRef.current < 100) return;
    lastLayoutSentRef.current = now;
    emitLayoutUpdate(node.id, node.position.x, node.position.y);
  }, []);

  // No live container fit during the drag: `expandParent` grows the box so the
  // node never escapes it, and the actual hug (shrinking to wrap all four
  // sides) runs once on drag-stop — see the layoutTick bump below. Keeping the
  // resize on release only is consistent across every edge of the box.
  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node): void => {
    isDraggingRef.current = false;
    draggingIdRef.current = null;
    // Host container moved: broadcast its new canvas position keyed by the
    // machine it represents (local → our hub; agent block → that hub). The
    // owner persists it + every view places the block there.
    if (node.type === HOST_NODE_TYPE) {
      const hubId = node.id === HOST_ID_LOCAL ? getSelfHubId() : node.id.slice(HOST_PREFIX_AGENT.length);
      if (hubId) {
        const pos = { x: node.position.x, y: node.position.y };
        setHostOverrides((o) => ({ ...o, [node.id]: pos })); // hold the dropped spot immediately
        emitHostLayout(hubId, pos.x, pos.y);
      }
      setLayoutTick((t) => t + 1);
      return;
    }
    // For child nodes the position is RELATIVE to its parent. Broadcast the
    // final position over the shared-layout channel: our API persists it if
    // it owns the node, otherwise the owning peer does — so the move is
    // durable AND every other open view converges on it.
    emitLayoutUpdate(node.id, node.position.x, node.position.y);
    // Re-run the rebuild so the host hugs all four sides around the dropped
    // position (the live drag only sized right/bottom).
    setLayoutTick((t) => t + 1);
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

  // Collaborative channel: apply incoming moves from other machines live, and
  // track peer cursors (expired by LOCAL receipt time so clock skew between
  // machines can't make a live cursor vanish).
  useEffect(() => {
    const unsubs = [
      onLayoutUpdate((u) => {
        if (draggingIdRef.current === u.node_id) return; // don't fight our own drag
        setNodes((nds) => nds.map((n) =>
          n.id === u.node_id && n.type !== HOST_NODE_TYPE
            ? { ...n, position: { x: u.x, y: u.y } }
            : n,
        ));
      }),
      onCursorUpdate((c) => {
        // Socket.IO's `broadcast` excludes our own socket, and the bus
        // subscriber drops same-hub re-loops — so anything reaching this
        // callback is, by construction, NOT our own cursor. (We used to
        // filter by hub_id here, which incorrectly hid every other client
        // on our hub.) Cursors are keyed by client_id when present so two
        // dashboards on one hub each get their own slot; falling back to
        // hub_id keeps cross-machine peers (pre-client_id) compatible.
        const key = (u: typeof c): string => u.client_id ?? u.hub_id;
        const rx = { ...c, ts: Date.now() };
        setCursors((prev) => [...prev.filter((p) => key(p) !== key(c)), rx]);
      }),
      onHostLayout((h) => {
        const hostId = h.hub_id === getSelfHubId() ? HOST_ID_LOCAL : `${HOST_PREFIX_AGENT}${h.hub_id}`;
        setHostOverrides((o) => ({ ...o, [hostId]: { x: h.x, y: h.y } }));
      }),
    ];
    const iv = setInterval(() => {
      const cutoff = Date.now() - 4000;
      setCursors((prev) => (prev.some((c) => c.ts < cutoff) ? prev.filter((c) => c.ts >= cutoff) : prev));
    }, 1000);
    return (): void => { for (const u of unsubs) u(); clearInterval(iv); };
  }, [setNodes]);

  // Broadcast our pointer (graph coords) at ~10/s for presence.
  const handlePaneMouseMove = useCallback((e: React.MouseEvent): void => {
    const now = Date.now();
    if (now - lastCursorSentRef.current < 100) return;
    const inst = rfInstanceRef.current as unknown as { screenToFlowPosition?: (p: { x: number; y: number }) => { x: number; y: number } } | null;
    if (!inst?.screenToFlowPosition) return;
    const p = inst.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    lastCursorSentRef.current = now;
    emitCursorUpdate(p.x, p.y);
  }, []);

  return (
    <div className="w-full h-full" onMouseMove={handlePaneMouseMove}>
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={handleNodeMouseEnter}
      onNodeMouseLeave={handleNodeMouseLeave}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      onInit={handleInit}
      deleteKeyCode={null}
      minZoom={0.15}
      maxZoom={4}
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
      <RemoteCursors cursors={cursors} />
    </ReactFlow>
    </div>
  );
}
