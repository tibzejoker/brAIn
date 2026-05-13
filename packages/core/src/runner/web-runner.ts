import {
  type NodeInfo,
  type NodeHandler,
  type NodeOnSpawn,
  type NodeTeardown,
  type Message,
  type RunMode,
  type WebTransportConfig,
} from "@brain/sdk";
import WebSocket from "ws";
import { BaseRunner, type RunnerDeps } from "./base-runner";
import { logger } from "../logger";

/**
 * Frame protocol over the WebSocket.
 *
 * All frames are JSON-encoded UTF-8 text frames.
 *
 * brAIn → node:
 *   { type: "messages", messages: Message[] }
 *   { type: "ping" }
 *
 * node → brAIn:
 *   { type: "publish", topic, payload, criticality, message_type?, metadata? }
 *   { type: "subscribe", topic, mailbox? }
 *   { type: "unsubscribe", topic }
 *   { type: "log", level, message, data? }
 *   { type: "pong" }
 */

interface MessagesFrame { type: "messages"; messages: Message[] }
interface PublishFrame {
  type: "publish";
  topic: string;
  payload: { content: string };
  criticality: number;
  message_type?: "text" | "file" | "alert";
  metadata?: Record<string, unknown>;
  /** If the node received a `messages` frame whose ids are still in
   *  scope, it can reference one here so the bus inherits trace_id.
   *  Optional — falls back to "first inbound message of the iteration"
   *  the same way local handlers do. */
  parent_id?: string;
}
interface SubscribeFrame { type: "subscribe"; topic: string; mailbox?: { max_size?: number; retention?: "latest" | "lowest_priority" } }
interface UnsubscribeFrame { type: "unsubscribe"; topic: string }
interface LogFrame { type: "log"; level: "info" | "warn" | "error" | "debug"; message: string; data?: Record<string, unknown> }
interface PingPongFrame { type: "ping" | "pong" }

type IncomingFrame = PublishFrame | SubscribeFrame | UnsubscribeFrame | LogFrame | PingPongFrame;
type OutgoingFrame = MessagesFrame | PingPongFrame;

const DEFAULT_RECONNECT_MIN_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 20_000;

/**
 * Runs a node that lives behind a remote HTTP/WS service. The runner
 * holds a long-lived WebSocket to the node and bridges bus messages ↔
 * protocol frames. The "handler" never executes locally — bus messages
 * for this node are forwarded as `messages` frames, and the node sends
 * back `publish`/`subscribe`/etc. frames that we apply on the bus.
 */
export class WebRunner extends BaseRunner {
  private readonly cfg: WebTransportConfig;
  private ws: WebSocket | null = null;
  private wsStop = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private currentBackoffMs: number;
  /** Last batch's first message id, used as default `parent_id` for
   *  outgoing publishes — same heuristic as BaseRunner.buildContext. */
  private lastInboundId: string | undefined;

  constructor(
    nodeInfo: NodeInfo,
    handler: NodeHandler,           // unused for web nodes; BaseRunner expects one
    deps: RunnerDeps,
    runMode?: RunMode,
    teardown?: NodeTeardown,
    onSpawn?: NodeOnSpawn,
  ) {
    super(nodeInfo, handler, deps, runMode, teardown, onSpawn);
    const fromOverride = nodeInfo.config_overrides?.web as WebTransportConfig | undefined;
    const fromInfo = this.getInfoCfg(nodeInfo);
    const cfg = fromOverride ?? fromInfo;
    if (!cfg) throw new Error(`web runner: no web config on node ${nodeInfo.name}`);
    this.cfg = cfg;
    this.currentBackoffMs = this.cfg.reconnect_min_ms ?? DEFAULT_RECONNECT_MIN_MS;
  }

  private getInfoCfg(info: NodeInfo): WebTransportConfig | undefined {
    // Per-instance config_overrides may carry the web block; otherwise
    // it lives on the registered NodeTypeConfig.web. We resolve via the
    // instance registry's known type if config_overrides didn't supply it.
    // For now, the spawn flow copies the type's web cfg into config_overrides
    // (see brain-lifecycle), so this fallback is rarely hit.
    return info.config_overrides?.web as WebTransportConfig | undefined;
  }

  protected async executionLoop(): Promise<void> {
    // Web nodes don't run a local handler — the runner sweeps the
    // mailbox and forwards everything to the remote node in one frame.
    // Then the runner parks until the next bus message arrives.
    this.flushToWs();
    await Promise.resolve();
  }

  private flushToWs(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Don't drain the mailbox until the socket is ready; otherwise
      // getUnreadMessages would mark them read and we'd lose them.
      return;
    }
    const messages = this.deps.bus.getUnreadMessages(this.nodeInfo.id);
    if (messages.length === 0) return;
    this.iteration++;
    this.lastInboundId = messages[0].id;
    this.log.info(`Iteration ${this.iteration}: forwarding ${messages.length} message(s) via web`);
    this.send({ type: "messages", messages });
  }

  start(): void {
    super.start();
    this.connect();
  }

  stop(): void {
    this.wsStop = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    super.stop();
  }

  private connect(): void {
    if (this.wsStop) return;
    const url = `${this.cfg.url.replace(/\/$/, "")}/brain/ws`;
    const headers: Record<string, string> = {};
    if (this.cfg.auth?.type === "bearer") {
      const token = process.env[this.cfg.auth.token_env];
      if (!token) {
        this.log.error(`web runner: missing env var ${this.cfg.auth.token_env} for bearer token`);
        // Try again once the user sets it; backoff to avoid spinning.
        this.scheduleReconnect();
        return;
      }
      headers.Authorization = `Bearer ${token}`;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers });
    } catch (err: unknown) {
      this.log.error(`web runner: connect threw — ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.currentBackoffMs = this.cfg.reconnect_min_ms ?? DEFAULT_RECONNECT_MIN_MS;
      this.log.info(`web socket open → ${url}`);
      this.startPing();
      // On (re)connect, flush any pending messages immediately.
      this.flushToWs();
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(raw.toString("utf8")) as IncomingFrame;
        this.handleFrame(frame);
      } catch (err) {
        this.log.warn(`web runner: malformed frame — ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ws.on("close", () => {
      this.stopPing();
      this.ws = null;
      if (!this.wsStop) this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      this.log.warn(`web socket error: ${err.message}`);
      // 'close' will follow and trigger the reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.wsStop) return;
    const max = this.cfg.reconnect_max_ms ?? DEFAULT_RECONNECT_MAX_MS;
    const delay = Math.min(this.currentBackoffMs, max);
    this.reconnectTimer = setTimeout(() => { this.connect(); }, delay);
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, max);
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.cfg.ping_interval_ms ?? DEFAULT_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private send(frame: OutgoingFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.log.warn(`web send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleFrame(frame: IncomingFrame): void {
    switch (frame.type) {
      case "publish":
        this.deps.bus.publish({
          from: this.nodeInfo.id,
          topic: frame.topic,
          type: frame.message_type ?? "text",
          criticality: frame.criticality,
          payload: frame.payload,
          metadata: frame.metadata,
          parent_id: frame.parent_id ?? this.lastInboundId,
        });
        break;
      case "subscribe":
        this.deps.bus.subscribe(this.nodeInfo.id, frame.topic, { mailbox: frame.mailbox });
        break;
      case "unsubscribe":
        this.deps.bus.unsubscribe(this.nodeInfo.id, frame.topic);
        break;
      case "log":
        this.log.add(frame.level, frame.message, frame.data);
        break;
      case "pong":
        // No-op; presence implies connection is alive.
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      default:
        logger.warn({ frame }, "web runner: unknown frame type");
    }
  }
}
