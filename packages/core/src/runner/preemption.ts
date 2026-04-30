/**
 * Preemption monitor — interrupts a running handler when an unread
 * message of significantly higher criticality lands on the bus.
 *
 * The runner owns one PreemptionMonitor; for each handler iteration
 * it calls `arm()` with the in-flight messages, then `disarm()` when
 * the handler returns. While armed, the runner calls `inspect()` from
 * its bus listener — if the highest unread criticality exceeds the
 * active iteration's bar by more than `threshold`, we abort the
 * controller and stash a `PreemptionContext` for the next call.
 */
import type { Message, PreemptionContext } from "@brain/sdk";
import type { IBusService } from "../bus/bus.interface";
import type { NodeLog } from "./node-log";

export interface PreemptionInspectResult {
  preempted: boolean;
  context: PreemptionContext | null;
}

interface ActiveRun {
  controller: AbortController;
  maxCriticality: number;
  messages: Message[];
}

export class PreemptionMonitor {
  private active: ActiveRun | null = null;
  private pending: PreemptionContext | null = null;

  constructor(
    private readonly bus: IBusService,
    private readonly nodeId: string,
    private readonly log: NodeLog,
    private readonly threshold: number,
  ) {}

  arm(messages: Message[]): { signal: AbortSignal; preemption: PreemptionContext | null } {
    const controller = new AbortController();
    const maxCriticality = messages.length === 0
      ? 0
      : messages.reduce((acc, m) => Math.max(acc, m.criticality), 0);
    this.active = { controller, maxCriticality, messages };
    const preemption = this.pending;
    this.pending = null;
    return { signal: controller.signal, preemption };
  }

  disarm(): void { this.active = null; }

  /** True iff the active handler aborted because of preemption. */
  wasPreempted(): boolean { return this.active?.controller.signal.aborted ?? false; }

  /**
   * Called from the runner's bus listener while a handler is busy.
   * Inspects unread messages without consuming them; aborts if any
   * exceed the active criticality bar by more than `threshold`.
   */
  inspect(): void {
    const active = this.active;
    if (!active || active.controller.signal.aborted) return;
    const unread = this.bus.readMessages(this.nodeId, { mode: "unread", peek: true });
    let highest: Message | null = null;
    for (const m of unread) {
      if (highest === null || m.criticality > highest.criticality) highest = m;
    }
    if (!highest) return;
    if (highest.criticality > active.maxCriticality + this.threshold) {
      this.log.info(
        `preempting iteration (active crit ${active.maxCriticality}, incoming ${highest.criticality} on ${highest.topic})`,
      );
      this.pending = {
        interrupting_message: highest,
        previous_messages: active.messages,
      };
      active.controller.abort(new Error(`preempted by ${highest.topic} (criticality ${highest.criticality})`));
    }
  }
}
