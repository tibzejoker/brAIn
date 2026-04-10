import { type Message, type WakeCondition, NodeState } from "@brain/sdk";
import { matchTopic } from "../bus/bus.matcher";
import type { BusService } from "../bus/bus.service";
import type { InstanceRegistry } from "../registry/instance-registry";

interface SleepingNode {
  nodeId: string;
  conditions: WakeCondition[];
  timers: NodeJS.Timeout[];
  wakeCallback: (msg?: Message) => void;
}

export class SleepService {
  private readonly sleepingNodes = new Map<string, SleepingNode>();

  constructor(
    private readonly bus: BusService,
    private readonly registry: InstanceRegistry,
  ) {
    // Listen to all published messages to check wake conditions
    this.bus.on("message:published", (msg: Message) => {
      this.checkWakeConditions(msg);
    });
  }

  registerSleep(
    nodeId: string,
    conditions: WakeCondition[],
    wakeCallback: (msg?: Message) => void,
  ): void {
    // Clean up existing sleep if any
    this.unregisterSleep(nodeId);

    const timers: NodeJS.Timeout[] = [];

    for (const cond of conditions) {
      if (cond.type === "timer") {
        const ms = this.parseInterval(cond.value);
        const timer = setTimeout(() => {
          this.wake(nodeId);
        }, ms);
        timers.push(timer);
      }
    }

    this.sleepingNodes.set(nodeId, {
      nodeId,
      conditions,
      timers,
      wakeCallback,
    });

    this.registry.updateState(nodeId, NodeState.SLEEPING);
  }

  unregisterSleep(nodeId: string): void {
    const sleeping = this.sleepingNodes.get(nodeId);
    if (sleeping) {
      for (const timer of sleeping.timers) {
        clearTimeout(timer);
      }
      this.sleepingNodes.delete(nodeId);
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

  private checkWakeConditions(msg: Message): void {
    for (const [, sleeping] of this.sleepingNodes) {
      for (const cond of sleeping.conditions) {
        if (cond.type === "any") {
          this.wake(sleeping.nodeId, msg);
          return;
        }
        if (cond.type === "topic") {
          if (!matchTopic(cond.value, msg.topic)) continue;
          if (
            cond.min_criticality !== undefined &&
            msg.criticality < cond.min_criticality
          )
            continue;
          this.wake(sleeping.nodeId, msg);
          return;
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
