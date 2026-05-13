import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server } from "socket.io";
import { BrainService } from "@brain/core";

/**
 * Trailing debounce window (ms) used to coalesce rapid node state
 * oscillations into a single emit. High-frequency reactive nodes
 * (e.g. one accel sample @ 10 Hz) can flip ACTIVE/STOPPED rapidly
 * and flood the dashboard, making the node icon strobe. Holding for
 * ~150 ms collapses the burst to one event with the terminal state
 * and is invisible to a human watching slower transitions.
 */
const STATE_DEBOUNCE_MS = 150;

@WebSocketGateway({ cors: true })
export class DashboardGateway implements OnGatewayInit {
  private readonly log = new Logger(DashboardGateway.name);
  private readonly stateTimers = new Map<string, NodeJS.Timeout>();
  private readonly statePending = new Map<string, { nodeId: string; from: string; to: string }>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly brain: BrainService) {}

  /** Per-node trailing debounce — keeps the latest event, drops the rest. */
  private debounceState(data: { nodeId: string; from: string; to: string }): void {
    const id = data.nodeId;
    this.statePending.set(id, data);
    const existing = this.stateTimers.get(id);
    if (existing) return; // a timer is already armed; the pending value will be flushed on fire
    const t = setTimeout(() => {
      this.stateTimers.delete(id);
      const final = this.statePending.get(id);
      this.statePending.delete(id);
      if (final) this.server.emit("node:state_changed", final);
    }, STATE_DEBOUNCE_MS);
    this.stateTimers.set(id, t);
  }

  afterInit(): void {
    this.brain.on("node:spawned", (node) => {
      // Reshape subscriptions to match what /network returns. The dashboard
      // uses `s.pattern` to colour-code topic handles; emitting the raw
      // NodeInfo (which has `s.topic`) crashed NodeBlock with
      // "Cannot read properties of undefined (reading 'length')" right
      // after a remote spawn.
      this.server.emit("node:spawned", {
        ...node,
        subscriptions: this.brain.bus.getSubscriptions(node.id),
        unread_count: this.brain.bus.getUnreadCount(node.id),
      });
    });

    this.brain.on("node:killed", (data) => {
      this.server.emit("node:killed", data);
    });

    this.brain.on("node:state_changed", (data) => {
      this.debounceState(data);
    });

    this.brain.on("message:published", (msg) => {
      this.server.emit("message:published", msg);
    });

    this.brain.on("devmode:changed", (data) => {
      this.server.emit("devmode:changed", data);
    });

    this.log.log("WebSocket gateway initialized");
  }
}
