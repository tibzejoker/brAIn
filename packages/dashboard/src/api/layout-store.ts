/**
 * Per-viewer node layout, persisted in localStorage.
 *
 * Node positions are otherwise owned by the hub that hosts the node: local
 * nodes persist server-side, but a REMOTE peer's nodes arrive fresh on every
 * 3 s `brain.network.snapshot` and can't be persisted back to us — so any
 * rearrangement of a peer's node was lost on reload (and clobbered live by
 * the next snapshot). This store lets each machine keep ITS OWN arrangement
 * of the whole merged graph — local and remote alike — surviving reloads and
 * snapshot churn, without changing what other viewers see.
 *
 * Positions are stored RELATIVE to the node's host container, matching what
 * React Flow reports on drag-stop and what the server persists for local
 * nodes.
 */
const KEY = "brain.layout.v1";

type PosMap = Record<string, { x: number; y: number }>;

function load(): PosMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as PosMap;
  } catch {
    return {};
  }
}

let cache: PosMap | null = null;
function map(): PosMap {
  if (!cache) cache = load();
  return cache;
}

export function getLayoutPos(nodeId: string): { x: number; y: number } | undefined {
  return map()[nodeId];
}

export function setLayoutPos(nodeId: string, x: number, y: number): void {
  const m = map();
  m[nodeId] = { x, y };
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* quota / private mode — keep the in-memory copy at least */
  }
}
