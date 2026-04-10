import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const PADDING = 40;

/**
 * Places nodes that don't have a saved position into empty spots,
 * avoiding overlap with existing positioned nodes.
 */
export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  // Collect occupied zones from nodes that already have a position
  const occupied: Array<{ x: number; y: number }> = [];
  const needsPlacement: number[] = [];

  const laidOut = [...nodes];

  for (let i = 0; i < laidOut.length; i++) {
    const pos = laidOut[i].position;
    if (pos.x !== 0 || pos.y !== 0) {
      occupied.push(pos);
    } else {
      needsPlacement.push(i);
    }
  }

  // Place unpositioned nodes in the first free slot
  for (const idx of needsPlacement) {
    const pos = findFreeSpot(occupied);
    occupied.push(pos);
    laidOut[idx] = { ...laidOut[idx], position: pos };
  }

  return { nodes: laidOut, edges };
}

function findFreeSpot(occupied: Array<{ x: number; y: number }>): { x: number; y: number } {
  const stepX = NODE_WIDTH + PADDING;
  const stepY = NODE_HEIGHT + PADDING;

  // Scan grid positions until we find one that doesn't overlap
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 6; col++) {
      const candidate = { x: 50 + col * stepX, y: 50 + row * stepY };
      const overlaps = occupied.some(
        (o) =>
          Math.abs(o.x - candidate.x) < NODE_WIDTH + PADDING / 2 &&
          Math.abs(o.y - candidate.y) < NODE_HEIGHT + PADDING / 2,
      );
      if (!overlaps) return candidate;
    }
  }

  // Fallback: place far right
  return { x: 50 + occupied.length * stepX, y: 50 };
}
