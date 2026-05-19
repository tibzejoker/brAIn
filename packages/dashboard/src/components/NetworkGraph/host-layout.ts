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
const HOST_ID_LOCAL = "host-local";
const HOST_PREFIX_AGENT = "host-agent-";
const HOST_PADDING_TOP = 30;       // room for the host header
const HOST_PADDING_INNER = 16;     // gutter between header / children / sides
const CHILD_W = 220;
const CHILD_H = 80;
const CHILD_GAP = 16;
const HOST_COLS = 3;               // 3-wide grid of children inside an active host
const HOST_GAP = 40;
const PASSIVE_HOST_W = 240;
const PASSIVE_HOST_H = 110;

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
  for (const s of snapshots) {
    const remoteId = (s as unknown as { target_agent_id?: string }).target_agent_id;
    const targetAgent = s.transport === "remote" && remoteId
      ? agentById.get(remoteId) ?? null
      : null;
    const hostId = hostIdFor(targetAgent);
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
    hostNodes.push({
      id: spec.id,
      type: HOST_NODE_TYPE,
      position: { x: cursorX, y: 50 },
      data: data as unknown as Record<string, unknown>,
      style: { width: size.w, height: size.h },
      draggable: true,
      selectable: false,
      zIndex: -1,
    });
    cursorX += size.w + HOST_GAP;
  }

  return { hostNodes, parentIdOf, gridSlotOf };
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
