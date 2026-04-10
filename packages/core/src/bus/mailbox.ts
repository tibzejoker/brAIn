import {
  type Message,
  type MailboxConfig,
  type ReadMessagesOptions,
  DEFAULT_MAILBOX_CONFIG,
} from "@brain/sdk";
import { matchTopic } from "./bus.matcher";

export class Mailbox {
  private readonly messages: Message[] = [];
  private readonly readIds = new Set<string>();
  private readonly config: MailboxConfig;

  constructor(config?: Partial<MailboxConfig>) {
    this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
  }

  push(msg: Message): void {
    if (this.messages.length >= this.config.max_size) {
      this.evict();
    }
    this.messages.push(msg);
  }

  readUnread(): Message[] {
    const unread = this.messages.filter((m) => !this.readIds.has(m.id));
    for (const m of unread) {
      this.readIds.add(m.id);
    }
    return unread;
  }

  readLatest(n: number): Message[] {
    return this.messages.slice(-n);
  }

  readAll(): Message[] {
    return [...this.messages];
  }

  read(opts: ReadMessagesOptions = {}): Message[] {
    const mode = opts.mode ?? "unread";

    let result: Message[];
    switch (mode) {
      case "unread":
        result = this.messages.filter((m) => !this.readIds.has(m.id));
        break;
      case "latest":
        result = this.messages.slice(-(opts.limit ?? this.messages.length));
        break;
      case "all":
        result = [...this.messages];
        break;
    }

    // Filter by topic pattern
    const topicFilter = opts.topic;
    if (topicFilter) {
      result = result.filter((m) => matchTopic(topicFilter, m.topic));
    }

    // Filter by criticality
    const minCrit = opts.min_criticality;
    if (minCrit !== undefined) {
      result = result.filter((m) => m.criticality >= minCrit);
    }

    // Apply limit
    if (opts.limit && mode !== "latest") {
      result = result.slice(-opts.limit);
    }

    // Mark as read unless peeking
    if (!opts.peek && mode === "unread") {
      for (const m of result) {
        this.readIds.add(m.id);
      }
    }

    return result;
  }

  hasUnread(): boolean {
    return this.messages.some((m) => !this.readIds.has(m.id));
  }

  get size(): number {
    return this.messages.length;
  }

  private evict(): void {
    if (this.config.retention === "lowest_priority") {
      // Remove the message with the lowest criticality
      let minIdx = 0;
      let minCrit = this.messages[0].criticality;
      for (let i = 1; i < this.messages.length; i++) {
        if (this.messages[i].criticality < minCrit) {
          minCrit = this.messages[i].criticality;
          minIdx = i;
        }
      }
      const removed = this.messages.splice(minIdx, 1)[0] as Message | undefined;
      if (removed) this.readIds.delete(removed.id);
    } else {
      // "latest" retention: remove oldest
      const removed = this.messages.shift();
      if (removed) this.readIds.delete(removed.id);
    }
  }
}
