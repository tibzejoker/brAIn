import { type Message, type WakeCondition, NodeState } from "@brain/sdk";
import type Database from "better-sqlite3";
import { matchTopic } from "../bus/bus.matcher";
import type { BusService } from "../bus/bus.service";
import type { InstanceRegistry } from "../registry/instance-registry";
import { saveSleepState, deleteSleepState, loadAllSleepStates } from "../db";
import { logger } from "../logger";

interface SleepingNode {
  nodeId: string;
  conditions: WakeCondition[];
  wakeAt: number | null;
  timer: NodeJS.Timeout | null;
  wakeCallback: (msg?: Message) => void;
}

const TICK_INTERVAL_MS = 5000;

export class SleepService {
  private readonly sleepingNodes = new Map<string, SleepingNode>();
  private tickTimer: NodeJS.Timeout | null = null;
  private db: Database.Database | null = null;

  constructor(
    private readonly bus: BusService,
    private readonly registry: InstanceRegistry,
  ) {
    this.bus.on("message:published", (msg: Message) => {
      this.checkWakeConditions(msg);
    });

    // Periodic tick to check timestamp-based wakes
    this.tickTimer = setInterval(() => {
      this.checkTimestampWakes();
    }, TICK_INTERVAL_MS);
  }

  setDb(db: Database.Database): void {
    this.db = db;
  }

  registerSleep(
    nodeId: string,
    conditions: WakeCondition[],
    wakeCallback: (msg?: Message) => void,
  ): void {
    this.unregisterSleep(nodeId);

    let wakeAt: number | null = null;
    let timer: NodeJS.Timeout | null = null;

    // Convert timer conditions to absolute timestamps
    for (const cond of conditions) {
      if (cond.type === "timer") {
        const ms = this.parseInterval(cond.value);
        wakeAt = Date.now() + ms;

        // Also set a setTimeout as a fast-path (for short sleeps within same process lifetime)
        timer = setTimeout(() => {
          this.wake(nodeId);
        }, ms);
        break;
      }
    }

    // Compute wake topics for persistence
    const wakeTopics = conditions
      .filter((c): c is WakeCondition & { type: "topic" } => c.type === "topic")
      .map((c) => c.value);
    const wakeOnAny = conditions.some((c) => c.type === "any");

    this.sleepingNodes.set(nodeId, {
      nodeId,
      conditions,
      wakeAt,
      timer,
      wakeCallback,
    });

    this.registry.updateState(nodeId, NodeState.SLEEPING);

    // Persist to DB (best-effort — node may have been killed)
    if (this.db) {
      try {
        saveSleepState(this.db, {
          node_id: nodeId,
          wake_at: wakeAt,
          wake_topics: JSON.stringify(wakeTopics),
          wake_on_any: wakeOnAny ? 1 : 0,
          created_at: Date.now(),
        });
      } catch {
        logger.debug({ nodeId }, "Failed to persist sleep state (node may be gone)");
      }
    }
  }

  unregisterSleep(nodeId: string): void {
    const sleeping = this.sleepingNodes.get(nodeId);
    if (sleeping) {
      if (sleeping.timer) {
        clearTimeout(sleeping.timer);
      }
      this.sleepingNodes.delete(nodeId);
    }

    // Clean from DB
    if (this.db) {
      deleteSleepState(this.db, nodeId);
    }
  }

  wake(nodeId: string, msg?: Message): void {
    const sleeping = this.sleepingNodes.get(nodeId);
    if (!sleeping) return;

    this.unregisterSleep(nodeId);
    this.registry.updateState(nodeId, NodeState.ACTIVE);
    sleeping.wakeCallback(msg);
  }

  isSleeping(nodeId: string): boolean {
    return this.sleepingNodes.has(nodeId);
  }

  /**
   * Restore sleep states from DB after a restart.
   * Called by BrainService.restore().
   * For each persisted sleep state:
   * - If wake_at is in the past → wake immediately
   * - If wake_at is in the future → set a timer for the remaining time
   * - Topic/any conditions are re-registered for bus matching
   */
  restoreSleepStates(wakeCallback: (nodeId: string) => void): number {
    if (!this.db) return 0;

    const saved = loadAllSleepStates(this.db);
    let restored = 0;

    for (const state of saved) {
      const node = this.registry.get(state.node_id);
      if (!node) continue;

      const now = Date.now();

      // If wake_at is set and already passed → wake immediately
      if (state.wake_at !== null && state.wake_at <= now) {
        logger.info(
          { nodeId: state.node_id, overdue_ms: now - state.wake_at },
          "Sleep timer expired during downtime, waking immediately",
        );
        deleteSleepState(this.db, state.node_id);
        this.registry.updateState(state.node_id, NodeState.ACTIVE);
        wakeCallback(state.node_id);
        restored++;
        continue;
      }

      // Rebuild conditions
      const conditions: WakeCondition[] = [];
      const topics = JSON.parse(state.wake_topics) as string[];
      for (const t of topics) {
        conditions.push({ type: "topic", value: t });
      }
      if (state.wake_on_any) {
        conditions.push({ type: "any" });
      }

      // Set timer for remaining time
      let timer: NodeJS.Timeout | null = null;
      if (state.wake_at !== null) {
        const remaining = state.wake_at - now;
        conditions.push({ type: "timer", value: `${remaining}ms` });
        timer = setTimeout(() => {
          this.wake(state.node_id);
        }, remaining);
      }

      this.sleepingNodes.set(state.node_id, {
        nodeId: state.node_id,
        conditions,
        wakeAt: state.wake_at,
        timer,
        wakeCallback: () => { wakeCallback(state.node_id); },
      });

      restored++;
    }

    if (restored > 0) {
      logger.info({ count: restored }, "Restored sleep states");
    }

    return restored;
  }

  destroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const [, sleeping] of this.sleepingNodes) {
      if (sleeping.timer) clearTimeout(sleeping.timer);
    }
    this.sleepingNodes.clear();
  }

  private checkTimestampWakes(): void {
    const now = Date.now();
    for (const [nodeId, sleeping] of this.sleepingNodes) {
      if (sleeping.wakeAt !== null && sleeping.wakeAt <= now) {
        logger.info({ nodeId }, "Timestamp wake triggered");
        this.wake(nodeId);
        continue;
      }

      // Safety net: if a sleeping node has unread messages, wake it if
      // conditions allow — catches race conditions where the message
      // arrived between handler return and registerSleep.
      if (!this.bus.hasUnreadMessages(nodeId)) continue;

      const wakeOnAny = sleeping.conditions.some((c) => c.type === "any");
      const wakeOnTopic = sleeping.conditions.some(
        (c) => c.type === "topic" && this.bus.hasUnreadForPattern(nodeId, c.value),
      );

      if (wakeOnAny || wakeOnTopic) {
        logger.info({ nodeId }, "Safety-net wake: unread messages for sleeping node");
        this.wake(nodeId);
      }
    }
  }

  private checkWakeConditions(msg: Message): void {
    const entries = Array.from(this.sleepingNodes.entries());
    logger.debug(
      { topic: msg.topic, from: msg.from, sleepingCount: entries.length },
      "checkWakeConditions",
    );
    for (const [, sleeping] of entries) {
      // First check if this message would actually reach the node's mailboxes
      // (i.e. matches at least one of its bus subscriptions)
      const nodeReaches = this.bus.wouldDeliver(sleeping.nodeId, msg);

      logger.debug(
        { nodeId: sleeping.nodeId, nodeReaches, conditions: sleeping.conditions, topic: msg.topic },
        "checkWake candidate",
      );

      for (const cond of sleeping.conditions) {
        if (cond.type === "any" && nodeReaches) {
          logger.info({ nodeId: sleeping.nodeId, topic: msg.topic }, "Waking on any");
          this.wake(sleeping.nodeId, msg);
          break;
        }
        if (cond.type === "topic") {
          const topicMatch = matchTopic(cond.value, msg.topic);
          logger.debug(
            { nodeId: sleeping.nodeId, pattern: cond.value, topic: msg.topic, topicMatch },
            "checkWake topic match",
          );
          if (!topicMatch) continue;
          if (
            cond.min_criticality !== undefined &&
            msg.criticality < cond.min_criticality
          ) continue;
          logger.info({ nodeId: sleeping.nodeId, topic: msg.topic, pattern: cond.value }, "Waking on topic");
          this.wake(sleeping.nodeId, msg);
          break;
        }
      }
    }
  }

  parseInterval(value: string): number {
    const match = value.match(/^(\d+)(ms|s|m|h)$/);
    if (!match) throw new Error(`Invalid interval: ${value}`);

    const num = parseInt(match[1], 10);
    switch (match[2]) {
      case "ms":
        return num;
      case "s":
        return num * 1000;
      case "m":
        return num * 60 * 1000;
      case "h":
        return num * 3600 * 1000;
      default:
        throw new Error(`Invalid interval unit: ${match[2]}`);
    }
  }
}
