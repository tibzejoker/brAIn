import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import {
  BrainService, resolveHubId, resolveHubLabel, getDb, setHubCanvasPos,
  NETWORK_LAYOUT_TOPIC, NETWORK_CURSOR_TOPIC, NETWORK_HOST_LAYOUT_TOPIC,
  type NetworkSnapshot, type LayoutUpdate, type CursorUpdate, type HostLayoutUpdate,
} from "@brain/core";
import type { HubRef } from "@brain/sdk";

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
  private hubId = "";
  private hubLabel = "";

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
    this.hubId = resolveHubId(getDb());
    this.hubLabel = resolveHubLabel();
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

    // Live wiring — a sub or publish was added/removed on a node here. Push
    // to all dashboards so they refresh the node's snapshot (the side panel
    // re-fetches via /nodes/:id, the graph picks the new edges up from the
    // updated subscriptions on the next /network read).
    this.brain.on("node:rewired", (data) => {
      this.server.emit("node:rewired", data);
    });

    this.brain.on("node:state_changed", (data) => {
      this.debounceState(data);
    });

    // Dynamic node types (de)registered by the scanner — push so the Node
    // Creator refreshes its spawnable list live, no page reload needed.
    this.brain.on("type:registered", (data) => this.server.emit("type:changed", { op: "registered", ...data }));
    this.brain.on("type:updated", (data) => this.server.emit("type:changed", { op: "updated", ...data }));
    this.brain.on("type:unregistered", (data) => this.server.emit("type:changed", { op: "unregistered", ...data }));

    this.brain.on("message:published", (msg) => {
      this.server.emit("message:published", msg);
    });

    this.brain.on("devmode:changed", (data) => {
      this.server.emit("devmode:changed", data);
    });

    // Agent presence — replaces the dashboard's 3 s getAgents() poll. The
    // directory fires `agent:announced` on every announce/refresh and
    // `agent:expired` when an entry lapses its TTL; we mirror both to clients
    // so host containers appear/update/vanish in real time.
    // Skip our own announcement — we already render as the "Local" host;
    // echoing it would add an empty duplicate agent card on our own graph.
    const selfId = resolveHubId(getDb());
    this.brain.agents.on("agent:announced", (ann) => {
      if (ann.agent_id === selfId) return;
      this.server.emit("agent:announced", ann);
    });

    this.brain.agents.on("agent:expired", (ann) => {
      this.server.emit("agent:expired", ann);
    });

    // Peer-hub network channel — a hub's live registry arriving/refreshing
    // (`hub:snapshot`) or going silent (`hub:expired`). We reshape each
    // remote node's subscriptions to the `{id, pattern}` shape the
    // dashboard's NodeBlock expects (their bus subs live on the peer, not
    // here) and emit so the merged graph updates in real time.
    this.brain.network.on("hub:snapshot", (snap: NetworkSnapshot) => {
      this.server.emit("network:hub_snapshot", {
        hub: snap.hub,
        nodes: snap.nodes.map((n) => ({
          ...n,
          owner_hub: snap.hub,
          subscriptions: n.subscriptions.map((s) => ({ id: `${n.id}:${s.topic}`, pattern: s.topic })),
        })),
      });
    });

    this.brain.network.on("hub:expired", (hub: HubRef) => {
      this.server.emit("network:hub_expired", { hub_id: hub.hub_id });
    });

    // Live shared layout + presence cursors. We bridge the bus (machine↔
    // machine) to our local dashboards (socket.io). A layout move from any
    // hub is forwarded to our clients AND persisted here if WE own that node
    // — that's what makes a drag survive reload/restart. Cursor updates are
    // ephemeral, just relayed. (Our own publishes are dropped by the bus
    // anti-loop, so we never echo to the originator.)
    const busId = "__brain.api.collab__";
    this.brain.bus.subscribe(busId, NETWORK_LAYOUT_TOPIC);
    this.brain.bus.subscribe(busId, NETWORK_CURSOR_TOPIC);
    this.brain.bus.subscribe(busId, NETWORK_HOST_LAYOUT_TOPIC);
    this.brain.bus.on(`message:${busId}`, (msg) => {
      const content = (msg.payload as { content?: string } | undefined)?.content;
      if (typeof content !== "string") return;
      if (msg.topic === NETWORK_LAYOUT_TOPIC) {
        let u: LayoutUpdate;
        try { u = JSON.parse(content) as LayoutUpdate; } catch { return; }
        if (u.by === this.hubId) return; // our own move — already handled in onLayoutIn
        this.persistIfOwned(u.node_id, u.x, u.y);
        this.server.emit("layout:update", u);
      } else if (msg.topic === NETWORK_HOST_LAYOUT_TOPIC) {
        let h: HostLayoutUpdate;
        try { h = JSON.parse(content) as HostLayoutUpdate; } catch { return; }
        if (h.by === this.hubId) return; // our own move — handled in onHostLayoutIn
        if (h.hub_id === this.hubId) setHubCanvasPos(getDb(), h.x, h.y); // we own this block
        this.server.emit("host:layout", h);
      } else {
        let c: CursorUpdate;
        try { c = JSON.parse(content) as CursorUpdate; } catch { return; }
        if (c.hub_id === this.hubId) return; // never relay our own cursor back
        this.server.emit("cursor:update", c);
      }
    });

    this.log.log("WebSocket gateway initialized");
  }

  /** Persist a node's position if WE host it — makes a drag (from any
   *  machine) durable on the owner. No-op for nodes owned by a peer. */
  private persistIfOwned(nodeId: string, x: number, y: number): void {
    if (this.brain.instanceRegistry.get(nodeId)) {
      this.brain.updatePosition(nodeId, x, y);
    }
  }

  // Each collab event takes TWO fan-out paths:
  //   1. socket.broadcast.emit → every OTHER local client on this gateway.
  //      Needed because the bus subscriber below drops same-hub re-loops
  //      (by hub_id) to avoid echoing our own publish back to the originator,
  //      which would otherwise also block client-to-client sync within one hub.
  //   2. bus.publish → peer hubs (other machines) consume via their own
  //      gateway and fan-out to THEIR local clients.
  // Two paths, zero overlap.

  /** A dashboard moved a node → persist if ours + fan-out to local peers + bus to remote hubs. */
  @SubscribeMessage("layout:update")
  onLayoutIn(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { node_id: string; x: number; y: number },
  ): void {
    if (!body.node_id) return;
    this.persistIfOwned(body.node_id, body.x, body.y);
    const u: LayoutUpdate = { node_id: body.node_id, x: body.x, y: body.y, by: this.hubId, ts: Date.now() };
    socket.broadcast.emit("layout:update", u);
    this.brain.bus.publish({
      from: `hub:${this.hubId}`, topic: NETWORK_LAYOUT_TOPIC, type: "text",
      criticality: 0, payload: { content: JSON.stringify(u) },
    });
  }

  /** A dashboard moved a machine's container → persist if it's OURS +
   *  fan-out to local peers + broadcast to remote hubs. */
  @SubscribeMessage("host:layout")
  onHostLayoutIn(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { hub_id: string; x: number; y: number },
  ): void {
    if (!body.hub_id) return;
    if (body.hub_id === this.hubId) setHubCanvasPos(getDb(), body.x, body.y);
    const h: HostLayoutUpdate = { hub_id: body.hub_id, x: body.x, y: body.y, by: this.hubId, ts: Date.now() };
    socket.broadcast.emit("host:layout", h);
    this.brain.bus.publish({
      from: `hub:${this.hubId}`, topic: NETWORK_HOST_LAYOUT_TOPIC, type: "text",
      criticality: 0, payload: { content: JSON.stringify(h) },
    });
  }

  /** A dashboard's pointer moved → fan-out to local peers + broadcast to remote hubs.
   *  `client_id` carries the originating socket.id so multiple dashboards on the
   *  same hub end up as distinct entries in the receiver's cursor state map. */
  @SubscribeMessage("cursor:update")
  onCursorIn(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { x: number; y: number },
  ): void {
    const c: CursorUpdate = {
      hub_id: this.hubId, client_id: socket.id, label: this.hubLabel,
      x: body.x, y: body.y, ts: Date.now(),
    };
    socket.broadcast.emit("cursor:update", c);
    this.brain.bus.publish({
      from: `hub:${this.hubId}`, topic: NETWORK_CURSOR_TOPIC, type: "text",
      criticality: 0, payload: { content: JSON.stringify(c) },
    });
  }
}
