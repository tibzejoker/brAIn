/**
 * Framework-level bus ↔ MCP request/reply bridge.
 *
 * Lets the API publish on any topic and await the result, using a
 * unique `mcp.bridge.reply.<reqId>` topic carried in `reply_to`. We
 * register a single phantom subscriber (`system.mcp-bridge`) once,
 * and resolve pending promises as replies land — no per-call
 * subscribe/unsubscribe churn.
 *
 * Same mechanic as the old mcp-export node, but lifted into the
 * framework so any HTTP path (per-node MCP, federated MCP, future
 * REST helpers) shares it without spawning a node.
 */
import { randomUUID } from "node:crypto";
import type { IBusService } from "../bus/bus.interface";
import type { Message, TextPayload } from "@brain/sdk";
import { logger } from "../logger";

const BRIDGE_NODE_ID = "system.mcp-bridge";
const REPLY_TOPIC_PREFIX = "mcp.bridge.reply.";

interface PendingReply {
  resolve: (raw: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MCPBridge {
  private readonly pending = new Map<string, PendingReply>();
  private installed = false;

  constructor(private readonly bus: IBusService) {}

  /**
   * Idempotent. Subscribes the phantom node to the reply topic
   * pattern and wires the message listener. Safe to call multiple
   * times — only the first run does work.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.bus.subscribe(BRIDGE_NODE_ID, `${REPLY_TOPIC_PREFIX}*`);
    this.bus.on(`message:${BRIDGE_NODE_ID}`, () => {
      // Drain whatever just landed. The bus delivers messages into a
      // mailbox keyed by node id; we read with `mode: "unread"` so
      // we only see fresh ones each iteration.
      const msgs: Message[] = this.bus.getUnreadMessages(BRIDGE_NODE_ID);
      for (const msg of msgs) this.deliver(msg);
    });
    logger.info("mcp-bridge: installed");
  }

  private deliver(msg: Message): void {
    if (!msg.topic.startsWith(REPLY_TOPIC_PREFIX)) return;
    const reqId = msg.topic.slice(REPLY_TOPIC_PREFIX.length);
    const entry = this.pending.get(reqId);
    if (!entry) return;
    this.pending.delete(reqId);
    clearTimeout(entry.timer);
    const payload = msg.payload as TextPayload;
    entry.resolve(typeof payload.content === "string" ? payload.content : JSON.stringify(payload));
  }

  /**
   * Publish on `topic` with serialized `args` and await the reply.
   * Resolves with the raw payload content string; rejects on timeout.
   */
  call(topic: string, args: unknown, timeoutMs = 30_000): Promise<string> {
    if (!this.installed) this.install();
    const reqId = randomUUID();
    const replyTopic = `${REPLY_TOPIC_PREFIX}${reqId}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`bus call to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.bus.publish({
          from: BRIDGE_NODE_ID,
          topic,
          type: "text",
          criticality: 3,
          payload: { content: typeof args === "string" ? args : JSON.stringify(args) },
          reply_to: replyTopic,
        });
      } catch (err) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Cancel every in-flight call, e.g. on shutdown. */
  shutdown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("mcp-bridge shutting down"));
    }
    this.pending.clear();
  }
}
