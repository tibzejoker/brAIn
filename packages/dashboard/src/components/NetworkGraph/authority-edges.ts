import type { Edge } from "@xyflow/react";
import type { NodeSnapshot } from "../../api/types";

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

export function buildAuthorityEdges(hoveredId: string | null, snapshots: NodeSnapshot[]): Edge[] {
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
