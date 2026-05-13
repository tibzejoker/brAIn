import {
  type Message,
  type ReadMessagesOptions,
  DEFAULT_MAILBOX_CONFIG,
} from "@brain/sdk";
import EventEmitter from "eventemitter3";
import { v4 as uuid } from "uuid";
import { matchTopic } from "./bus.matcher";
import { Mailbox } from "./mailbox";
import { runPublishValidation } from "./publish-validator";
import type { IBusService, SubscribeOptions, BusMailboxView } from "./bus.interface";

interface Subscription {
  id: string;
  pattern: string;
  min_criticality?: number;
  mailbox: Mailbox;
}

/**
 * **In-memory bus — test fixture only.** Production code always uses
 * `NatsBusService` against the broker started by `BrokerService` —
 * see `packages/api/src/app.module.ts` for the wiring. This class
 * stays exported because dozens of unit tests rely on a synchronous,
 * network-less `IBusService` impl, and instantiating it in tests is
 * cheaper + clearer than spinning up NATS for every test that
 * doesn't actually exercise routing.
 *
 * If you reach for this in a non-test context, you're skipping the
 * bus the rest of the framework runs on — don't.
 */
export class BusService extends EventEmitter implements IBusService {
  // nodeId -> subscriptionId -> Subscription
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();

  // All messages for tracing
  private readonly messageHistory: Message[] = [];
  private readonly maxHistory = 10000;

  publish(msg: Omit<Message, "id" | "timestamp"> & { from: string }): Message {
    // Causal tracing: every published message lands with a trace_id.
    // - explicit trace_id wins (system code can pin one)
    // - else inherit from the parent message if known
    // - else allocate a fresh one (this message is the chain root)
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

    // Store in history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }

    // Phase 1 schema validation — log-only, message still delivered below.
    runPublishValidation(this, message);

    // Route to matching subscriptions (skip sender to prevent self-loops)
    for (const [nodeId, nodeSubs] of this.subscriptions) {
      if (nodeId === message.from) continue;
      for (const [, sub] of nodeSubs) {
        if (!matchTopic(sub.pattern, message.topic)) continue;
        if (
          sub.min_criticality !== undefined &&
          message.criticality < sub.min_criticality
        )
          continue;

        sub.mailbox.push(message);

        // Emit per-node event for the runner to detect new messages
        this.emit(`message:${nodeId}`, message);
      }
    }

    // Global event
    this.emit("message:published", message);

    return message;
  }

  subscribe(
    nodeId: string,
    topic: string,
    config?: SubscribeOptions,
  ): string {
    if (!this.subscriptions.has(nodeId)) {
      this.subscriptions.set(nodeId, new Map());
    }

    const subId = uuid();
    const sub: Subscription = {
      id: subId,
      pattern: topic,
      min_criticality: config?.min_criticality,
      mailbox: new Mailbox({
        ...DEFAULT_MAILBOX_CONFIG,
        ...config?.mailbox,
      }),
    };

    const nodeSubs = this.subscriptions.get(nodeId);
    if (nodeSubs) {
      nodeSubs.set(subId, sub);
    }
    return subId;
  }

  unsubscribe(nodeId: string, topicOrSubId: string): boolean {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return false;

    // Try by subscription ID first
    if (nodeSubs.has(topicOrSubId)) {
      nodeSubs.delete(topicOrSubId);
      return true;
    }

    // Try by topic pattern
    for (const [subId, sub] of nodeSubs) {
      if (sub.pattern === topicOrSubId) {
        nodeSubs.delete(subId);
        return true;
      }
    }

    return false;
  }

  removeAllSubscriptions(nodeId: string): void {
    this.subscriptions.delete(nodeId);
  }

  getUnreadMessages(nodeId: string): Message[] {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return [];

    const allUnread: Message[] = [];
    const seen = new Set<string>();

    for (const [, sub] of nodeSubs) {
      for (const msg of sub.mailbox.readUnread()) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          allUnread.push(msg);
        }
      }
    }

    // Sort by criticality (highest first), then by timestamp
    allUnread.sort(
      (a, b) => b.criticality - a.criticality || a.timestamp - b.timestamp,
    );
    return allUnread;
  }

  readMessages(nodeId: string, opts: ReadMessagesOptions = {}): Message[] {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return [];

    const allMessages: Message[] = [];
    const seen = new Set<string>();

    for (const [, sub] of nodeSubs) {
      // If filtering by topic, only read from matching subscriptions
      if (opts.topic && !matchTopic(opts.topic, sub.pattern) && !matchTopic(sub.pattern, opts.topic)) {
        continue;
      }

      for (const msg of sub.mailbox.read(opts)) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          allMessages.push(msg);
        }
      }
    }

    allMessages.sort(
      (a, b) => b.criticality - a.criticality || a.timestamp - b.timestamp,
    );

    if (opts.limit) {
      return allMessages.slice(0, opts.limit);
    }

    return allMessages;
  }

  getUnreadCount(nodeId: string): number {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return 0;
    let count = 0;
    for (const [, sub] of nodeSubs) {
      count += sub.mailbox.read({ mode: "unread", peek: true }).length;
    }
    return count;
  }

  hasUnreadMessages(nodeId: string): boolean {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return false;

    for (const [, sub] of nodeSubs) {
      if (sub.mailbox.hasUnread()) return true;
    }
    return false;
  }

  hasUnreadForPattern(nodeId: string, pattern: string): boolean {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return false;

    for (const [, sub] of nodeSubs) {
      if (!matchTopic(pattern, sub.pattern) && !matchTopic(sub.pattern, pattern)) continue;
      if (sub.mailbox.hasUnread()) return true;
    }
    return false;
  }

  getHighestUnreadCriticality(nodeId: string): number {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return -1;

    let max = -1;
    for (const [, sub] of nodeSubs) {
      const unread = sub.mailbox.read({ mode: "unread", peek: true });
      for (const msg of unread) {
        if (msg.criticality > max) max = msg.criticality;
      }
    }
    return max;
  }

  wouldDeliver(nodeId: string, msg: Message): boolean {
    if (nodeId === msg.from) return false;
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return false;
    for (const [, sub] of nodeSubs) {
      if (!matchTopic(sub.pattern, msg.topic)) continue;
      if (sub.min_criticality !== undefined && msg.criticality < sub.min_criticality) continue;
      return true;
    }
    return false;
  }

  getMailboxes(nodeId: string): BusMailboxView[] {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return [];
    return Array.from(nodeSubs.values()).map((sub) => {
      const all = sub.mailbox.readAll();
      const unread = sub.mailbox.read({ mode: "unread", peek: true });
      return {
        pattern: sub.pattern,
        total: all.length,
        unread: unread.length,
        capacity: sub.mailbox.capacity,
        dropped: sub.mailbox.dropped,
        messages: all.slice(-20).map((m) => ({
          id: m.id,
          topic: m.topic,
          criticality: m.criticality,
          from: m.from,
          timestamp: m.timestamp,
          preview: ((m.payload as { content?: string }).content ?? JSON.stringify(m.payload)).slice(0, 100),
        })),
      };
    });
  }

  getSubscriptions(nodeId: string): Array<{ id: string; pattern: string }> {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return [];
    return Array.from(nodeSubs.values()).map((s) => ({
      id: s.id,
      pattern: s.pattern,
    }));
  }

  getMessageHistory(opts?: {
    topic?: string;
    from?: string;
    to?: string;
    last?: number;
    since?: number;
    min_criticality?: number;
  }): Message[] {
    let result = this.messageHistory;

    const topic = opts?.topic;
    if (topic) {
      result = result.filter((m) => matchTopic(topic, m.topic));
    }
    const from = opts?.from;
    if (from) {
      result = result.filter((m) => m.from === from);
    }
    const since = opts?.since;
    if (since !== undefined) {
      result = result.filter((m) => m.timestamp >= since);
    }
    const minCrit = opts?.min_criticality;
    if (minCrit !== undefined) {
      result = result.filter((m) => m.criticality >= minCrit);
    }

    const last = opts?.last ?? 20;
    return result.slice(-last);
  }

  /** Look up a message by id in the history buffer (recent ~10k only). */
  findById(messageId: string): Message | undefined {
    // Reverse scan because lookups are usually for very recent messages
    // (in-flight chain expansion, replays, …).
    for (let i = this.messageHistory.length - 1; i >= 0; i--) {
      if (this.messageHistory[i].id === messageId) return this.messageHistory[i];
    }
    return undefined;
  }

  /**
   * Return every message in the same causal chain (same trace_id),
   * oldest first. Used by the dashboard to render a flow / by debug
   * tools to replay an interaction.
   */
  getTrace(traceId: string): Message[] {
    return this.messageHistory.filter((m) => m.trace_id === traceId);
  }
}
