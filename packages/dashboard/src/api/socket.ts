import { io, type Socket } from "socket.io-client";
import type {
  NodeSnapshot,
  Message,
  StateChangeEvent,
  KillEvent,
  HubSnapshotEvent,
  HubExpiredEvent,
  LayoutUpdate,
  CursorUpdate,
  HostLayoutUpdate,
} from "./types";
import type { AgentSnapshot } from "./client";

/** Framework-internal high-frequency topics (peer-sync snapshots/cursors,
 *  agent discovery, LLM telemetry, control commands). They flood the human
 *  message monitor and the flow graph with no conversational value — and
 *  with 2+ hubs cross-publishing they can churn the dashboard hard enough
 *  to make the tab unresponsive. Filtered out of the monitor + flow hooks. */
export function isInfraTopic(topic: string): boolean {
  return topic.startsWith("brain.network.")
    || topic.startsWith("brain.agents.")
    || topic === "llm.usage";
}

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io("/", {
      transports: ["websocket"],
      autoConnect: true,
    });
  }
  return socket;
}

export function onNodeSpawned(cb: (node: NodeSnapshot) => void): () => void {
  const s = getSocket();
  s.on("node:spawned", cb);
  return (): void => {
    s.off("node:spawned", cb);
  };
}

export function onNodeKilled(cb: (event: KillEvent) => void): () => void {
  const s = getSocket();
  s.on("node:killed", cb);
  return (): void => {
    s.off("node:killed", cb);
  };
}

export function onNodeStateChanged(
  cb: (event: StateChangeEvent) => void,
): () => void {
  const s = getSocket();
  s.on("node:state_changed", cb);
  return (): void => {
    s.off("node:state_changed", cb);
  };
}

/** A dynamic node type was (de)registered by the scanner — the spawnable
 *  type list changed, so the Node Creator should refetch without a reload. */
export function onTypeChanged(
  cb: (event: { op: "registered" | "updated" | "unregistered"; typeName: string }) => void,
): () => void {
  const s = getSocket();
  s.on("type:changed", cb);
  return (): void => {
    s.off("type:changed", cb);
  };
}

/** Fired by the API whenever a node's subscriptions or publishes are
 *  edited via the live-wiring endpoints. Carries the nodeId so the
 *  side panel re-fetches just that node's snapshot. */
export interface RewireEvent {
  nodeId: string;
  op: "add_subscription" | "remove_subscription" | "add_publish" | "remove_publish";
  topic: string;
}
export function onNodeRewired(cb: (event: RewireEvent) => void): () => void {
  const s = getSocket();
  s.on("node:rewired", cb);
  return (): void => {
    s.off("node:rewired", cb);
  };
}

export function onMessagePublished(cb: (msg: Message) => void): () => void {
  const s = getSocket();
  s.on("message:published", cb);
  return (): void => {
    s.off("message:published", cb);
  };
}

// Agent presence — fired on every announce/refresh so the graph can upsert
// host containers live (no polling). `ts` lets the client ignore an out-of-
// order stale payload if one ever arrives.
export function onAgentAnnounced(cb: (agent: AgentSnapshot) => void): () => void {
  const s = getSocket();
  s.on("agent:announced", cb);
  return (): void => {
    s.off("agent:announced", cb);
  };
}

export function onAgentExpired(cb: (agent: AgentSnapshot) => void): () => void {
  const s = getSocket();
  s.on("agent:expired", cb);
  return (): void => {
    s.off("agent:expired", cb);
  };
}

// Peer-hub network channel — a remote machine's live registry arriving or
// refreshing. Each node carries `owner_hub`, so the merged graph can group
// it under its owning machine and route its UI to that hub's HTTP base.
export function onNetworkHubSnapshot(cb: (e: HubSnapshotEvent) => void): () => void {
  const s = getSocket();
  s.on("network:hub_snapshot", cb);
  return (): void => {
    s.off("network:hub_snapshot", cb);
  };
}

export function onNetworkHubExpired(cb: (e: HubExpiredEvent) => void): () => void {
  const s = getSocket();
  s.on("network:hub_expired", cb);
  return (): void => {
    s.off("network:hub_expired", cb);
  };
}

// === Collaborative layout + presence (client → server emits) ===

/** Tell our API a node moved → it persists if it owns it + broadcasts to peers. */
export function emitLayoutUpdate(nodeId: string, x: number, y: number): void {
  getSocket().emit("layout:update", { node_id: nodeId, x, y });
}

/** Broadcast our pointer position (graph coords) to peers. */
export function emitCursorUpdate(x: number, y: number): void {
  getSocket().emit("cursor:update", { x, y });
}

/** A node moved on some machine — apply it to our graph live. */
export function onLayoutUpdate(cb: (u: LayoutUpdate) => void): () => void {
  const s = getSocket();
  s.on("layout:update", cb);
  return (): void => { s.off("layout:update", cb); };
}

/** Another client's pointer moved. */
export function onCursorUpdate(cb: (c: CursorUpdate) => void): () => void {
  const s = getSocket();
  s.on("cursor:update", cb);
  return (): void => { s.off("cursor:update", cb); };
}

/** Tell our API a machine's container moved → owner persists + peers update. */
export function emitHostLayout(hubId: string, x: number, y: number): void {
  getSocket().emit("host:layout", { hub_id: hubId, x, y });
}

/** A machine's container moved on some view — reposition its block. */
export function onHostLayout(cb: (h: HostLayoutUpdate) => void): () => void {
  const s = getSocket();
  s.on("host:layout", cb);
  return (): void => { s.off("host:layout", cb); };
}
