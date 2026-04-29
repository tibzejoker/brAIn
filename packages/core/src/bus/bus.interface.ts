/**
 * `IBusService` — abstract bus contract.
 *
 * Two concrete implementations exist (or will exist):
 *
 *   - `BusService` (in-memory) — single-process, default for solo
 *     deployments and dev. Today's behaviour.
 *   - `NatsBusService` (planned, Phase 4.2) — distributed, replaces
 *     in-memory routing with a NATS publish/subscribe so nodes on
 *     different machines share the same bus. Mailboxes stay local
 *     per-node (each runner owns its own queue).
 *
 * Consumers (BrainService, runners, controllers) hold an
 * `IBusService` reference; the concrete impl is wired at construction.
 */
import type EventEmitter from "eventemitter3";
import type { MailboxConfig, Message, ReadMessagesOptions } from "@brain/sdk";

export interface BusMailboxView {
  pattern: string;
  total: number;
  unread: number;
  messages: Array<{
    id: string;
    topic: string;
    criticality: number;
    from: string;
    timestamp: number;
    preview: string;
  }>;
}

export interface BusSubscription {
  id: string;
  pattern: string;
}

export interface BusHistoryOptions {
  topic?: string;
  from?: string;
  to?: string;
  last?: number;
  since?: number;
  min_criticality?: number;
}

/** Subscription registration options. */
export interface SubscribeOptions {
  min_criticality?: number;
  mailbox?: Partial<MailboxConfig>;
}

/**
 * Public bus contract. Inherits the EventEmitter surface so the
 * runner can `bus.on(`message:${nodeId}`, fn)` without caring about
 * the underlying transport.
 *
 * Note: declaring `extends EventEmitter` here gives implementations a
 * working in-memory event bus for free; for distributed buses, the
 * remote messages are translated into local events on the implementer
 * side, so consumers can keep the same listener pattern.
 */
export interface IBusService extends EventEmitter {
  // === Routing ===
  publish(msg: Omit<Message, "id" | "timestamp"> & { from: string }): Message;
  subscribe(nodeId: string, topic: string, config?: SubscribeOptions): string;
  unsubscribe(nodeId: string, topicOrSubId: string): boolean;
  removeAllSubscriptions(nodeId: string): void;

  // === Mailbox readers (always local — each node's queue lives where
  // its runner runs, even in a distributed setup). ===
  getUnreadMessages(nodeId: string): Message[];
  readMessages(nodeId: string, opts?: ReadMessagesOptions): Message[];
  getUnreadCount(nodeId: string): number;
  hasUnreadMessages(nodeId: string): boolean;
  hasUnreadForPattern(nodeId: string, pattern: string): boolean;
  getHighestUnreadCriticality(nodeId: string): number;
  wouldDeliver(nodeId: string, msg: Message): boolean;
  getMailboxes(nodeId: string): BusMailboxView[];
  getSubscriptions(nodeId: string): BusSubscription[];

  // === History / tracing (in-memory snapshot of recent traffic). ===
  getMessageHistory(opts?: BusHistoryOptions): Message[];
  findById(messageId: string): Message | undefined;
  getTrace(traceId: string): Message[];
}
