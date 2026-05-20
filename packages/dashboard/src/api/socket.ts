import { io, type Socket } from "socket.io-client";
import type {
  NodeSnapshot,
  Message,
  StateChangeEvent,
  KillEvent,
  HubSnapshotEvent,
  HubExpiredEvent,
} from "./types";
import type { AgentSnapshot } from "./client";

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
