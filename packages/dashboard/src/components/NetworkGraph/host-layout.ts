import type { Node } from "@xyflow/react";
import type { NodeSnapshot } from "../../api/types";
import type { AgentSnapshot } from "../../api/client";
import type { HostGroupData, HostKind } from "./HostGroup";

// ============================================================================
// Hosts layer
// ============================================================================
// Each "host" (this brAIn process + every announced brain-agent) is rendered
// as a labelled container that physically holds its nodes. Children get
// `parentId: hostId` + `expandParent: true` (set at the call site) so they
// stick to a parent visually but the parent grows if the user drags an
// child past its current border. Layout puts active-host containers in a row
// from the left; passive hosts (no types announced — brAIn-mobile, raw bus
// publishers) land beside them as small empty cards. Pruning is implicit:
// when an agent stops announcing, `getAgents()` drops it on the next poll
// and its container vanishes from the graph + the AgentsPanel.

export const HOST_NODE_TYPE = "hostGroup";
export const HOST_ID_LOCAL = "host-local";
export const HOST_PREFIX_AGENT = "host-agent-";
const HOST_PADDING_TOP = 30;       // room for the host header
const HOST_PADDING_INNER = 16;     // gutter between header / children / sides
const CHILD_W = 220;
const CHILD_H = 80;
const CHILD_GAP = 16;
const HOST_COLS = 3;               // 3-wide grid of children inside an active host
const HOST_GAP = 40;
const PASSIVE_HOST_W = 240;
const PASSIVE_HOST_H = 110;
// A host never shrinks below a single child cell — keeps the header label
// readable even when its one node is dragged into the top-left corner.
const MIN_HOST_W = HOST_PADDING_INNER * 2 + CHILD_W;
const MIN_HOST_H = HOST_PADDING_TOP + HOST_PADDING_INNER * 2 + CHILD_H;

// Map an agent (or null = local) to a synthetic host id used as parentId on
// its hosted nodes. Stable across renders so React Flow doesn't re-mount.
function hostIdFor(agent: { agent_id: string } | null): string {
  return agent ? `${HOST_PREFIX_AGENT}${agent.agent_id}` : HOST_ID_LOCAL;
}

// Pick a glyph for the host header. Local always wears its own glyph; every
// other host gets a single generic one by default. Agents can override by
// surfacing a `device_icon` string in their announce payload — read here
// through a defensive cast so the AgentSnapshot type doesn't have to bake
// it in yet.
const DEFAULT_AGENT_ICON = "💠";
function hostIcon(kind: HostKind, agent: AgentSnapshot | null): string {
  if (kind === "local") return "🖥️";
  const custom = (agent as unknown as { device_icon?: string } | null)?.device_icon;
  return typeof custom === "string" && custom.length > 0 ? custom : DEFAULT_AGENT_ICON;
}

/**
 * Build the host containers + decide each snapshot's parentId.
 *
 * Returns:
 *   - `hostNodes`: ordered React Flow group nodes (Local first, then each
 *     agent). Positioned in a row from x=0; sized by child count for active
 *     hosts, fixed-small for passive (or empty).
 *   - `parentIdOf`: lookup snapshot.id → parentId, set by snapshotToFlowNode
 *     at the call site.
 *   - `gridSlotOf`: lookup snapshot.id → fallback grid slot inside its host
 *     (used ONLY for nodes whose stored `position` is (0, 0), i.e. freshly
 *     spawned). Otherwise the stored position is reused as-is and persisted
 *     by `updateNodePosition` on drag-stop — relative to the parent now,
 *     since that's what React Flow expects when `parentId` is set.
 */
export function buildHostLayer(
  snapshots: NodeSnapshot[],
  agents: AgentSnapshot[],
  // Synced container positions keyed by host id (host-local / host-agent-<id>).
  // When present for a host, its block is placed there instead of the auto row.
  canvasPosByHost?: Map<string, { x: number; y: number }>,
): {
  hostNodes: Node[];
  parentIdOf: Map<string, string>;
  gridSlotOf: Map<string, { x: number; y: number }>;
} {
  const agentById = new Map(agents.map((a) => [a.agent_id, a]));

  // 1. Group snapshots by their host (Local | known agent). A `remote` node
  // whose `target_agent_id` no longer matches an announced agent falls back
  // to Local rather than disappearing — the API will eventually prune it
  // but the dashboard shouldn't strand zombies meanwhile.
  const childrenByHost = new Map<string, NodeSnapshot[]>();
  const parentIdOf = new Map<string, string>();
  // Peer hubs discovered via `owner_hub` (machine-level guest mode). hub_id
  // equals the peer's agent_id, so we key on the SAME `host-agent-<id>` slot
  // an announced agent would use — a peer that also announces presence shares
  // one container instead of duplicating. label/http_url feed its spec below.
  const peerHubs = new Map<string, { hub_id: string; hub_label: string; http_url?: string }>();
  for (const s of snapshots) {
    let hostId: string;
    if (s.owner_hub) {
      hostId = hostIdFor({ agent_id: s.owner_hub.hub_id });
      if (!peerHubs.has(hostId)) peerHubs.set(hostId, s.owner_hub);
    } else {
      const remoteId = (s as unknown as { target_agent_id?: string }).target_agent_id;
      const targetAgent = s.transport === "remote" && remoteId
        ? agentById.get(remoteId) ?? null
        : null;
      hostId = hostIdFor(targetAgent);
    }
    parentIdOf.set(s.id, hostId);
    const bucket = childrenByHost.get(hostId) ?? [];
    bucket.push(s);
    childrenByHost.set(hostId, bucket);
  }

  // 2. Define every host that should be visible — Local always, plus every
  // announced agent. Local first so it sits left-most.
  type HostSpec = { id: string; kind: HostKind; label: string; sublabel?: string; agent: AgentSnapshot | null };
  const specs: HostSpec[] = [
    { id: HOST_ID_LOCAL, kind: "local", label: "Local", sublabel: "this brAIn process", agent: null },
  ];
  for (const a of agents) {
    const isActive = a.types.length > 0;
    specs.push({
      id: hostIdFor(a),
      kind: isActive ? "active-agent" : "passive",
      label: a.host,
      sublabel: a.agent_id.slice(0, 12),
      agent: a,
    });
  }
  // Peer hubs that aren't already shown as an announced agent get their own
  // container, labelled with the machine's hub label.
  const specIds = new Set(specs.map((sp) => sp.id));
  for (const [hostId, hub] of peerHubs) {
    if (specIds.has(hostId)) continue;
    specs.push({
      id: hostId,
      kind: "active-agent",
      label: hub.hub_label,
      sublabel: hub.hub_id.slice(0, 12),
      agent: null,
    });
  }

  // 3. Compute fallback grid slots inside each host + host sizes.
  const gridSlotOf = new Map<string, { x: number; y: number }>();
  const hostSize = new Map<string, { w: number; h: number }>();
  for (const spec of specs) {
    const kids = childrenByHost.get(spec.id) ?? [];
    if (kids.length === 0) {
      hostSize.set(spec.id, { w: PASSIVE_HOST_W, h: PASSIVE_HOST_H });
      continue;
    }
    const cols = Math.min(HOST_COLS, kids.length);
    const rows = Math.ceil(kids.length / HOST_COLS);
    const w = HOST_PADDING_INNER * 2 + cols * CHILD_W + (cols - 1) * CHILD_GAP;
    const h = HOST_PADDING_TOP + HOST_PADDING_INNER + rows * CHILD_H + (rows - 1) * CHILD_GAP + HOST_PADDING_INNER;
    hostSize.set(spec.id, { w, h });
    kids.forEach((k, i) => {
      const col = i % HOST_COLS;
      const row = Math.floor(i / HOST_COLS);
      gridSlotOf.set(k.id, {
        x: HOST_PADDING_INNER + col * (CHILD_W + CHILD_GAP),
        y: HOST_PADDING_TOP + HOST_PADDING_INNER + row * (CHILD_H + CHILD_GAP),
      });
    });
  }

  // 4. Place each host in a row left-to-right.
  const hostNodes: Node[] = [];
  let cursorX = 50;
  for (const spec of specs) {
    const size = hostSize.get(spec.id) ?? { w: PASSIVE_HOST_W, h: PASSIVE_HOST_H };
    const data: HostGroupData = {
      kind: spec.kind,
      label: spec.label,
      sublabel: spec.sublabel,
      icon: hostIcon(spec.kind, spec.agent),
      isEmpty: (childrenByHost.get(spec.id) ?? []).length === 0,
    };
    const synced = canvasPosByHost?.get(spec.id);
    hostNodes.push({
      id: spec.id,
      type: HOST_NODE_TYPE,
      position: synced ?? { x: cursorX, y: 50 },
      data: data,
      style: { width: size.w, height: size.h },
      draggable: true,
      selectable: false,
      zIndex: -1,
    });
    cursorX += size.w + HOST_GAP;
  }

  return { hostNodes, parentIdOf, gridSlotOf };
}

/**
 * Tighten each host container to wrap its children's CURRENT positions.
 *
 * `buildHostLayer` only sizes a host by child *count* (a 3-wide grid), and
 * React Flow's `expandParent` only ever *grows* the parent when a child is
 * dragged out — neither shrinks it back when nodes are dragged closer
 * together. Recomputing the real bounding box from the resolved child
 * positions on every poll is what lets the box collapse to the smallest size
 * that still holds its nodes (previously this only happened on a full page
 * refresh, when React Flow remounted from scratch).
 *
 * Mutates `hostNodes[i].style` in place. Only right/bottom extents are needed:
 * `expandParent` keeps child relative coords >= 0 by shifting the parent on
 * top/left overflow, so the origin stays put. Empty/passive hosts (no kids)
 * are left at their fixed card size. Expanded nodes contribute their expanded
 * footprint so the container grows to hold the open iframe panel.
 */
/**
 * Hug a host's box around its children on ALL FOUR sides. The box can only
 * shrink from the right/bottom by sizing alone — its top-left IS the host
 * origin, so closing a top/left gap means sliding the origin toward the content
 * and counter-shifting the children by the same amount (their absolute screen
 * position is unchanged; only the dashed border moves in). Called on rebuild /
 * drag-stop, never mid-drag: translating a node while it's under the cursor
 * fights React Flow's drag controller, so the hug is deferred to drag-stop.
 */
export function fitHostsToChildren(
  hostNodes: Node[],
  childNodes: Node[],
  expandedSizes: Map<string, { w: number; h: number }>,
): void {
  const TOP_PAD = HOST_PADDING_TOP + HOST_PADDING_INNER; // header + gutter
  const kidsByParent = new Map<string, Node[]>();
  for (const c of childNodes) {
    const parentId = (c as { parentId?: string }).parentId;
    if (!parentId) continue;
    const bucket = kidsByParent.get(parentId) ?? [];
    bucket.push(c);
    kidsByParent.set(parentId, bucket);
  }

  for (const host of hostNodes) {
    const kids = kidsByParent.get(host.id);
    if (!kids || kids.length === 0) continue; // leave passive/empty at fixed size

    let minX = Infinity, minY = Infinity, maxRight = 0, maxBottom = 0;
    for (const k of kids) {
      // Use the child's REAL footprint, not the CHILD_W/CHILD_H grid constants:
      // a NodeBlock with handles/topics is taller than 80px, so the constant
      // landed the box edge at the item's *centre*. Priority: explicit expanded
      // size → React Flow's measured DOM size → grid fallback (pre-measure).
      const dims = k as unknown as { measured?: { width?: number; height?: number } };
      const w = expandedSizes.get(k.id)?.w ?? dims.measured?.width ?? CHILD_W;
      const h = expandedSizes.get(k.id)?.h ?? dims.measured?.height ?? CHILD_H;
      minX = Math.min(minX, k.position.x);
      minY = Math.min(minY, k.position.y);
      maxRight = Math.max(maxRight, k.position.x + w);
      maxBottom = Math.max(maxBottom, k.position.y + h);
    }

    // Slide the origin so the top-left-most child sits at the standard
    // padding, then move the host the opposite way so nothing visually jumps.
    const shiftX = minX - HOST_PADDING_INNER;
    const shiftY = minY - TOP_PAD;
    if (shiftX !== 0 || shiftY !== 0) {
      host.position = { x: host.position.x + shiftX, y: host.position.y + shiftY };
      for (const k of kids) k.position = { x: k.position.x - shiftX, y: k.position.y - shiftY };
    }
    const width = Math.max((maxRight - minX) + HOST_PADDING_INNER * 2, MIN_HOST_W);
    const height = Math.max((maxBottom - minY) + TOP_PAD + HOST_PADDING_INNER, MIN_HOST_H);

    // Write the size on EVERY field React Flow may read: `expandParent`
    // stamps the grown size onto the top-level `width`/`height` (and
    // `measured`), which then *overrides* `style` — so updating `style` alone
    // never shrinks the box. Setting all of them lets it collapse again.
    const h = host as unknown as {
      width?: number; height?: number;
      measured?: { width?: number; height?: number };
      style?: Record<string, unknown>;
    };
    h.width = width;
    h.height = height;
    h.measured = { width, height };
    h.style = { ...h.style, width, height };
  }
}

// Read a host node's effective dimension across the fields React Flow may
// carry it in: an explicit `width`/`height` (what `expandParent` mutates when
// it grows the parent), the ResizeObserver `measured` size, then our inline
// `style`. Lets `sameRenderedShape` notice when a host needs resizing — both
// when expandParent has grown it and when `fitHostsToChildren` shrinks it.
function hostDim(n: Node, axis: "width" | "height"): number | string | undefined {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured;
  const style = n.style;
  if (axis === "width") return (n as { width?: number }).width ?? measured?.width ?? style?.width;
  return (n as { height?: number }).height ?? measured?.height ?? style?.height;
}

// Compact "is this functionally the same node array?" check used to skip
// redundant React Flow re-renders on identical snapshot polls. Compares
// the fields that actually affect rendering — IDs, parent, type, and the
// data fields NodeBlock + HostGroup consume. Position is intentionally
// excluded: it's sticky-applied to `next` at the call site before this
// runs, so by the time we compare, child positions in both arrays match
// when the node hasn't moved.
const RENDERED_DATA_KEYS = [
  "label", "state", "transport", "targetAgentId",
  "isExpanded", "expandedWidth", "expandedHeight",
  "unreadCount", "authorityLevel", "showCapabilityLayer",
  "kind", "icon", "sublabel", "isEmpty",
] as const;

export function sameRenderedShape(prev: Node[], next: Node[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.id !== b.id) return false;
    if (a.type !== b.type) return false;
    if ((a as { parentId?: string }).parentId !== (b as { parentId?: string }).parentId) return false;
    // Host containers re-render on a size OR origin change so the box can hug
    // all four sides (expandParent only grows it; the recomputed fit + origin
    // slide must actually apply). Position is otherwise excluded, but for a
    // host the origin IS the box's top-left edge.
    if (a.type === HOST_NODE_TYPE) {
      if (hostDim(a, "width") !== hostDim(b, "width")) return false;
      if (hostDim(a, "height") !== hostDim(b, "height")) return false;
      if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
    }
    const ad = a.data;
    const bd = b.data;
    for (const k of RENDERED_DATA_KEYS) {
      if (ad[k] !== bd[k]) return false;
    }
    const aSubs = (ad.subscribes as string[] | undefined) ?? [];
    const bSubs = (bd.subscribes as string[] | undefined) ?? [];
    if (aSubs.length !== bSubs.length || aSubs.join("|") !== bSubs.join("|")) return false;
    const aPubs = (ad.publishes as string[] | undefined) ?? [];
    const bPubs = (bd.publishes as string[] | undefined) ?? [];
    if (aPubs.length !== bPubs.length || aPubs.join("|") !== bPubs.join("|")) return false;
  }
  return true;
}
