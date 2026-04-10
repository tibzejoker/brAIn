import {
  type Message,
  type MailboxConfig,
  type ReadMessagesOptions,
  DEFAULT_MAILBOX_CONFIG,
} from "@brain/sdk";
import EventEmitter from "eventemitter3";
import { v4 as uuid } from "uuid";
import { matchTopic } from "./bus.matcher";
import { Mailbox } from "./mailbox";

interface Subscription {
  id: string;
  pattern: string;
  min_criticality?: number;
  mailbox: Mailbox;
}

export class BusService extends EventEmitter {
  // nodeId -> subscriptionId -> Subscription
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();

  // All messages for tracing
  private readonly messageHistory: Message[] = [];
  private readonly maxHistory = 10000;

  publish(msg: Omit<Message, "id" | "timestamp"> & { from: string }): Message {
    const message: Message = {
      ...msg,
      id: uuid(),
      timestamp: Date.now(),
    };

    // Store in history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }

    // Route to matching subscriptions
    for (const [nodeId, nodeSubs] of this.subscriptions) {
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
    config?: {
      min_criticality?: number;
      mailbox?: Partial<MailboxConfig>;
    },
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

  hasUnreadMessages(nodeId: string): boolean {
    const nodeSubs = this.subscriptions.get(nodeId);
    if (!nodeSubs) return false;

    for (const [, sub] of nodeSubs) {
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
}
