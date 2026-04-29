/**
 * `NatsBusService` — NATS-backed implementation of `IBusService`.
 *
 * Routing semantics:
 *   - Every published message is forwarded to the NATS broker on
 *     `<prefix>.<topic>` (default prefix `brain`). Other brAIn
 *     instances connected to the same NATS receive the message and
 *     route it through their LOCAL bus to local subscribers.
 *   - Subscriptions are tracked locally (which node wants which topic
 *     pattern + min_criticality + mailbox config). On each remote
 *     message we replay routing through the local subscription map —
 *     the same code path the in-memory bus uses, just with foreign
 *     `from`s.
 *   - Per-node mailboxes always live where the node's runner runs;
 *     they're never shipped over the wire.
 *
 * Anti-loop:
 *   - Each instance tags messages with `__brain_origin` (a random per-
 *     process uuid) so we can detect and drop messages we ourselves
 *     just published when they come back through the NATS subscription.
 *   - Same-node anti-loop (a node not receiving its own messages) is
 *     enforced on routing, exactly like in-memory.
 *
 * History/tracing:
 *   - Each instance keeps its own in-memory history (10k recent, like
 *     `BusService`). Cross-instance trace queries aggregate via the
 *     network later (Phase 6.4 — replay), out of scope here.
 *
 * Wildcard topic translation:
 *   - brAIn topics use dots + `*` for greedy match (`alerts.*` matches
 *     all depths). NATS uses `>` for the same. We translate at publish
 *     and subscribe boundaries: NATS subscribes on `<prefix>.>` and
 *     filters locally via `matchTopic` to preserve the brAIn semantics
 *     (NATS' own `*` is single-token only, which doesn't match ours).
 */
import {
  DEFAULT_MAILBOX_CONFIG,
  type Message,
  type ReadMessagesOptions,
} from "@brain/sdk";
import EventEmitter from "eventemitter3";
import { v4 as uuid } from "uuid";
import { connect, StringCodec, type NatsConnection, type Subscription as NatsSubscription } from "nats";
import { logger } from "../logger";
import { matchTopic } from "./bus.matcher";
import { Mailbox } from "./mailbox";
import type {
  BusHistoryOptions, BusMailboxView, BusSubscription,
  IBusService, SubscribeOptions,
} from "./bus.interface";

interface Subscription {
  id: string;
  pattern: string;
  min_criticality?: number;
  mailbox: Mailbox;
}

export interface NatsBusOptions {
  /** NATS server URL (default `nats://localhost:4222`). */
  url?: string;
  /** Subject prefix shared by all brAIn instances (default `brain`). */
  prefix?: string;
  /** Optional bearer/token auth. */
  token?: string;
  /** Max messages kept in the local history snapshot (default 10000). */
  history_max?: number;
}

export class NatsBusService extends EventEmitter implements IBusService {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();
  private readonly messageHistory: Message[] = [];
  private readonly historyMax: number;
  private readonly prefix: string;
  private readonly originId = uuid();
  private readonly codec = StringCodec();

  private nc: NatsConnection | null = null;
  private natsSub: NatsSubscription | null = null;

  constructor(private readonly opts: NatsBusOptions = {}) {
    super();
    this.prefix = opts.prefix ?? "brain";
    this.historyMax = opts.history_max ?? 10000;
  }

  /** Connect to NATS and start listening on `<prefix>.>`. Idempotent. */
  async connect(): Promise<void> {
    if (this.nc) return;
    const url = this.opts.url ?? "nats://localhost:4222";
    const log = logger.child({ svc: "nats-bus", url });
    log.info("connecting");
    this.nc = await connect({
      servers: url,
      token: this.opts.token,
      reconnect: true,
      maxReconnectAttempts: -1,
      waitOnFirstConnect: true,
    });
    log.info({ origin: this.originId }, "connected");
    this.natsSub = this.nc.subscribe(`${this.prefix}.>`);
    void this.consumeRemote();
  }

  async close(): Promise<void> {
    try { await this.natsSub?.drain(); } catch { /* ignore */ }
    try { await this.nc?.drain(); } catch { /* ignore */ }
    this.natsSub = null;
    this.nc = null;
  }

  // === Routing ===

  publish(msg: Omit<Message, "id" | "timestamp"> & { from: string }): Message {
    let traceId = msg.trace_id;
    if (!traceId && msg.parent_id) {
      const parent = this.findById(msg.parent_id);
      if (parent?.trace_id) traceId = parent.trace_id;
    }
    const message: Message = {
      ...msg,
      id: uuid(),
      timestamp: Date.now(),
      trace_id: traceId ?? uuid(),
    };

    this.recordHistory(message);
    this.routeLocally(message);

    // Push to NATS for other instances. Sanitize the topic into a
    // single dotted subject (NATS subjects allow dots and alphanums).
    if (this.nc) {
      const subject = `${this.prefix}.${this.sanitizeTopic(message.topic)}`;
      const envelope = JSON.stringify({ origin: this.originId, message });
      try {
        this.nc.publish(subject, this.codec.encode(envelope));
      } catch (err) {
        logger.warn({ err }, "nats publish failed (continuing local-only)");
      }
    }

    this.emit("message:published", message);
    return message;
  }

  subscribe(nodeId: string, topic: string, config?: SubscribeOptions): string {
    if (!this.subscriptions.has(nodeId)) this.subscriptions.set(nodeId, new Map());
    const subId = uuid();
    const sub: Subscription = {
      id: subId,
      pattern: topic,
      min_criticality: config?.min_criticality,
      mailbox: new Mailbox({ ...DEFAULT_MAILBOX_CONFIG, ...config?.mailbox }),
    };
    const nodeSubs = this.subscriptions.get(nodeId);
    if (nodeSubs) nodeSubs.set(subId, sub);
    return subId;
  }

  unsubscribe(nodeId: string, topicOrSubId: string): boolean {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return false;
    if (subs.has(topicOrSubId)) {
      subs.delete(topicOrSubId);
      return true;
    }
    for (const [id, sub] of subs) {
      if (sub.pattern === topicOrSubId) { subs.delete(id); return true; }
    }
    return false;
  }

  removeAllSubscriptions(nodeId: string): void {
    this.subscriptions.delete(nodeId);
  }

  // === Local mailbox readers ===
  getUnreadMessages(nodeId: string): Message[] {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return [];
    const out: Message[] = [];
    for (const sub of subs.values()) out.push(...sub.mailbox.read({ mode: "unread" }));
    return out;
  }

  readMessages(nodeId: string, opts: ReadMessagesOptions = {}): Message[] {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return [];
    const out: Message[] = [];
    for (const sub of subs.values()) {
      if (opts.topic && !matchTopic(opts.topic, sub.pattern)) continue;
      out.push(...sub.mailbox.read(opts));
    }
    if (opts.limit !== undefined) return out.slice(0, opts.limit);
    return out;
  }

  getUnreadCount(nodeId: string): number {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return 0;
    let n = 0;
    for (const sub of subs.values()) n += sub.mailbox.read({ mode: "unread", peek: true }).length;
    return n;
  }

  hasUnreadMessages(nodeId: string): boolean {
    return this.getUnreadCount(nodeId) > 0;
  }

  hasUnreadForPattern(nodeId: string, pattern: string): boolean {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return false;
    for (const sub of subs.values()) {
      if (!matchTopic(pattern, sub.pattern) && !matchTopic(sub.pattern, pattern)) continue;
      if (sub.mailbox.read({ mode: "unread", peek: true }).length > 0) return true;
    }
    return false;
  }

  getHighestUnreadCriticality(nodeId: string): number {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return 0;
    let max = 0;
    for (const sub of subs.values()) {
      for (const m of sub.mailbox.read({ mode: "unread", peek: true })) {
        if (m.criticality > max) max = m.criticality;
      }
    }
    return max;
  }

  wouldDeliver(nodeId: string, msg: Message): boolean {
    if (msg.from === nodeId) return false;
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return false;
    for (const sub of subs.values()) {
      if (!matchTopic(sub.pattern, msg.topic)) continue;
      if (sub.min_criticality !== undefined && msg.criticality < sub.min_criticality) continue;
      return true;
    }
    return false;
  }

  getMailboxes(nodeId: string): BusMailboxView[] {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return [];
    return Array.from(subs.values()).map((sub) => {
      const all = sub.mailbox.readAll();
      const unread = sub.mailbox.read({ mode: "unread", peek: true });
      return {
        pattern: sub.pattern,
        total: all.length,
        unread: unread.length,
        messages: all.slice(-20).map((m) => ({
          id: m.id, topic: m.topic, criticality: m.criticality, from: m.from,
          timestamp: m.timestamp,
          preview: ((m.payload as { content?: string }).content ?? JSON.stringify(m.payload)).slice(0, 100),
        })),
      };
    });
  }

  getSubscriptions(nodeId: string): BusSubscription[] {
    const subs = this.subscriptions.get(nodeId);
    if (!subs) return [];
    return Array.from(subs.values()).map((s) => ({ id: s.id, pattern: s.pattern }));
  }

  // === History / tracing ===
  getMessageHistory(opts: BusHistoryOptions = {}): Message[] {
    let out = this.messageHistory;
    const topic = opts.topic;
    if (topic !== undefined) out = out.filter((m) => matchTopic(topic, m.topic));
    if (opts.from) out = out.filter((m) => m.from === opts.from);
    const since = opts.since;
    if (since !== undefined) out = out.filter((m) => m.timestamp >= since);
    const minCrit = opts.min_criticality;
    if (minCrit !== undefined) out = out.filter((m) => m.criticality >= minCrit);
    return out.slice(-(opts.last ?? 20));
  }

  findById(id: string): Message | undefined {
    for (let i = this.messageHistory.length - 1; i >= 0; i--) {
      if (this.messageHistory[i].id === id) return this.messageHistory[i];
    }
    return undefined;
  }

  getTrace(traceId: string): Message[] {
    return this.messageHistory.filter((m) => m.trace_id === traceId);
  }

  // === Internals ===

  private async consumeRemote(): Promise<void> {
    if (!this.natsSub) return;
    for await (const m of this.natsSub) {
      try {
        const env = JSON.parse(this.codec.decode(m.data)) as { origin: string; message: Message };
        if (env.origin === this.originId) continue;  // own publish round-tripping
        this.recordHistory(env.message);
        this.routeLocally(env.message);
        this.emit("message:published", env.message);
      } catch (err) {
        logger.warn({ err }, "nats-bus: malformed envelope");
      }
    }
  }

  private routeLocally(message: Message): void {
    for (const [nodeId, subs] of this.subscriptions) {
      if (nodeId === message.from) continue;  // anti-loop
      for (const sub of subs.values()) {
        if (!matchTopic(sub.pattern, message.topic)) continue;
        if (sub.min_criticality !== undefined && message.criticality < sub.min_criticality) continue;
        sub.mailbox.push(message);
        this.emit(`message:${nodeId}`, message);
      }
    }
  }

  private recordHistory(message: Message): void {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.historyMax) this.messageHistory.shift();
  }

  /** Replace characters that NATS rejects in subjects (`*`, ` `, …). */
  private sanitizeTopic(topic: string): string {
    return topic.replace(/[^A-Za-z0-9_.-]/g, "_");
  }
}
