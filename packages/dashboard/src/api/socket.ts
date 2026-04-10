import { io, type Socket } from "socket.io-client";
import type {
  NodeSnapshot,
  Message,
  StateChangeEvent,
  KillEvent,
} from "./types";

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
