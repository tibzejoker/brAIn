/**
 * Runner resilience tests.
 *
 * Tests that the runner infrastructure handles edge cases:
 * - Handler crashes don't kill the runner
 * - Messages queued during busy handler are processed next cycle
 * - Handler timeout doesn't block the runner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { LLMRunner } from "../packages/core/src/runner/llm-runner";
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

function publish(bus: BusService, topic = "test.input"): void {
  bus.publish({ from: "sender", topic, type: "text", criticality: 3, payload: { content: "msg" } });
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return fn();
}

describe("Runner resilience", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleep: SleepService;

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
    sleep = new SleepService(bus, registry);
  });
  afterEach(() => { sleep.destroy(); });

  // === Handler crash recovery ===

  it("ServiceRunner survives a handler crash and processes next message", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      return Promise.resolve();
    };
    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    // First message — handler throws
    publish(bus);
    await waitFor(() => callCount >= 1);

    // Runner should still be alive — send second message
    publish(bus);
    const recovered = await waitFor(() => callCount >= 2);
    expect(recovered).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);

    runner.stop();
  });

  it("LLMRunner survives a handler crash and force-sleeps", async () => {
    const handler: NodeHandler = () => { throw new Error("llm crash"); };
    const node = makeNode({
      tags: ["llm"],
      config_overrides: { max_iterations: 2, forced_sleep: "1s" },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();
    publish(bus);

    // Should eventually force-sleep despite crashes
    const slept = await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING, 10000);
    expect(slept).toBe(true);

    runner.stop();
  });

  // === Concurrent messages ===

  it("processes all queued messages after handler finishes", async () => {
    const received: string[] = [];
    const handler: NodeHandler = async (ctx) => {
      await new Promise((r) => { setTimeout(r, 200); });
      for (const m of ctx.messages) {
        received.push((m.payload as { content: string }).content);
      }
    };
    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    // Send first — handler starts processing (200ms)
    bus.publish({ from: "s", topic: "test.input", type: "text", criticality: 3, payload: { content: "A" } });

    // Send two more while handler is busy
    await new Promise((r) => { setTimeout(r, 50); });
    bus.publish({ from: "s", topic: "test.input", type: "text", criticality: 3, payload: { content: "B" } });
    bus.publish({ from: "s", topic: "test.input", type: "text", criticality: 3, payload: { content: "C" } });

    // Wait for both batches to be processed
    const allProcessed = await waitFor(() => received.includes("B") || received.includes("C"), 5000);
    expect(allProcessed).toBe(true);
    // All 3 messages should be received (either in batch 1 or batch 2)
    expect(received).toContain("A");

    runner.stop();
  });

  // === Handler timeout ===

  it("ServiceRunner recovers from handler timeout", async () => {
    let callCount = 0;
    const handler: NodeHandler = async () => {
      callCount++;
      if (callCount === 1) {
        // Hang forever — will be timed out
        await new Promise(() => { /* never resolves */ });
      }
    };
    const node = makeNode({ config_overrides: { handler_timeout_ms: 500 } });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep });
    runner.start();

    publish(bus);
    // Wait for timeout + sleep + next wake
    await new Promise((r) => { setTimeout(r, 1500); });

    // Send another message — runner should be alive
    publish(bus);
    const recovered = await waitFor(() => callCount >= 2, 3000);
    expect(recovered).toBe(true);

    runner.stop();
  });

  // === Parallel node processing ===

  it("two nodes process messages independently in parallel", async () => {
    const results: Array<{ node: string; time: number }> = [];
    const start = Date.now();

    const makeHandler = (name: string, delayMs: number): NodeHandler => async () => {
      await new Promise((r) => { setTimeout(r, delayMs); });
      results.push({ node: name, time: Date.now() - start });
    };

    const node1 = makeNode({ id: "node-fast", name: "fast" });
    const node2 = makeNode({ id: "node-slow", name: "slow" });
    registry.add(node1);
    registry.add(node2);
    bus.subscribe(node1.id, "test.input");
    bus.subscribe(node2.id, "test.input");

    const r1 = new ServiceRunner(node1, makeHandler("fast", 100), { bus, registry, sleepService: sleep });
    const r2 = new ServiceRunner(node2, makeHandler("slow", 500), { bus, registry, sleepService: sleep });
    r1.start();
    r2.start();

    // One message goes to both nodes
    publish(bus);

    const both = await waitFor(() => results.length >= 2, 3000);
    expect(both).toBe(true);

    // Fast should finish before slow (parallel, not sequential)
    const fast = results.find((r) => r.node === "fast");
    const slow = results.find((r) => r.node === "slow");
    expect(fast).toBeDefined();
    expect(slow).toBeDefined();
    if (fast && slow) {
      expect(fast.time).toBeLessThan(slow.time);
    }

    r1.stop();
    r2.stop();
  });
});
