/**
 * Preemption — runner aborts an in-flight handler when a higher
 * criticality message lands, and re-invokes it with a
 * PreemptionContext on the next iteration.
 *
 * Covered:
 * - AbortSignal in ctx.signal fires when an incoming msg exceeds
 *   the active iteration's criticality + threshold.
 * - The next iteration sees `wasPreempted: true` +
 *   `preemptionContext.interrupting_message` set to the urgent msg.
 * - Below-threshold incoming messages do NOT preempt — they wait.
 * - Configurable `preemption_threshold` is honoured.
 * - Natural handler errors are still recorded in DLQ (preemption
 *   path mustn't swallow real failures).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "test", name: "test", description: "", tags: [],
    authority_level: 0, state: NodeState.ACTIVE, priority: 3,
    subscriptions: [{ topic: "test.input" }],
    transport: "process", position: { x: 0, y: 0 },
    config_overrides: {}, default_publishes: ["test.output"],
    created_at: Date.now(),
    ...overrides,
  };
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return fn();
}

describe("Preemption", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleep: SleepService;

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
    sleep = new SleepService(bus, registry);
  });
  afterEach(() => { sleep.destroy(); });

  it("aborts an in-flight handler when a high-criticality msg lands", async () => {
    let abortedDuringHandler = false;
    const iterationsSeen: Array<{ iter: number; preempted: boolean }> = [];

    const handler: NodeHandler = async (ctx) => {
      iterationsSeen.push({ iter: ctx.iteration, preempted: ctx.wasPreempted });
      // Simulate a long-running async op that respects AbortSignal
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          abortedDuringHandler = true;
          reject(new Error("aborted"));
        });
      });
    };

    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    // Iter 1: low criticality msg starts the handler
    bus.publish({ from: "low", topic: "test.input", type: "text", criticality: 2, payload: { content: "low" } });
    await waitFor(() => iterationsSeen.length >= 1);

    // While handler is still in flight, send a high-crit msg → preemption
    bus.publish({ from: "high", topic: "test.input", type: "text", criticality: 9, payload: { content: "FIRE" } });

    // The runner aborts iter 1 and re-runs as iter 2 with wasPreempted=true
    await waitFor(() => iterationsSeen.length >= 2 && iterationsSeen[1].preempted);
    expect(abortedDuringHandler).toBe(true);
    expect(iterationsSeen[0].preempted).toBe(false);
    expect(iterationsSeen[1].preempted).toBe(true);

    runner.stop();
  });

  it("wires preemptionContext.interrupting_message + previous_messages", async () => {
    let captured: { interrupting?: string; prev_count?: number } = {};
    const handler: NodeHandler = async (ctx) => {
      if (ctx.wasPreempted && ctx.preemptionContext) {
        const im = ctx.preemptionContext.interrupting_message;
        captured = {
          interrupting: (im.payload as { content: string }).content,
          prev_count: ctx.preemptionContext.previous_messages.length,
        };
        return;
      }
      // First iter: hang until aborted
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    bus.publish({ from: "low", topic: "test.input", type: "text", criticality: 2, payload: { content: "boring" } });
    await waitFor(() => true, 100);
    bus.publish({ from: "alarm", topic: "test.input", type: "text", criticality: 9, payload: { content: "URGENT" } });

    await waitFor(() => captured.interrupting === "URGENT");
    expect(captured.interrupting).toBe("URGENT");
    expect(captured.prev_count).toBe(1);

    runner.stop();
  });

  it("does NOT preempt when criticality differential ≤ threshold (default 3)", async () => {
    let aborted = false;
    let iterations = 0;
    const handler: NodeHandler = async (ctx) => {
      iterations++;
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 600);
          ctx.signal.addEventListener("abort", () => { clearTimeout(t); aborted = true; reject(new Error("a")); });
        });
      } catch { /* expected if aborted */ }
    };

    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    // iter 1 starts at criticality 4
    bus.publish({ from: "a", topic: "test.input", type: "text", criticality: 4, payload: { content: "x" } });
    await waitFor(() => iterations >= 1, 500);

    // crit 6 = +2 above 4, threshold is 3, so this must NOT preempt
    bus.publish({ from: "b", topic: "test.input", type: "text", criticality: 6, payload: { content: "y" } });
    await new Promise((r) => { setTimeout(r, 700); });
    expect(aborted).toBe(false);

    runner.stop();
  });

  it("honours config_overrides.preemption_threshold", async () => {
    let aborted = false;
    const handler: NodeHandler = async (ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 600);
          ctx.signal.addEventListener("abort", () => { clearTimeout(t); aborted = true; reject(new Error("a")); });
        });
      } catch { /* expected */ }
    };

    // threshold=0 → any strictly-higher criticality preempts
    const node = makeNode({ config_overrides: { preemption_threshold: 0 } });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    bus.publish({ from: "a", topic: "test.input", type: "text", criticality: 3, payload: { content: "x" } });
    await new Promise((r) => { setTimeout(r, 50); });
    bus.publish({ from: "b", topic: "test.input", type: "text", criticality: 4, payload: { content: "y" } });

    await waitFor(() => aborted, 1000);
    expect(aborted).toBe(true);

    runner.stop();
  });

  it("a natural handler error still lands in the DLQ (not silently swallowed)", async () => {
    const handler: NodeHandler = () => Promise.reject(new Error("genuine bug"));
    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    bus.publish({ from: "src", topic: "test.input", type: "text", criticality: 1, payload: { content: "x" } });
    await waitFor(() => runner.getDeadLetters().length > 0);

    const dlq = runner.getDeadLetters();
    expect(dlq[0].error).toContain("genuine bug");

    runner.stop();
  });
});
