import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { LLMRunner } from "../packages/core/src/runner/llm-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

function makeNodeInfo(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "test",
    name: "test",
    description: "",
    tags: [],
    authority_level: 0,
    state: NodeState.ACTIVE,
    priority: 3,
    subscriptions: [{ topic: "test.input" }],
    transport: "process",
    position: { x: 0, y: 0 },
    config_overrides: {},
    default_publishes: ["test.output"],
    created_at: Date.now(),
    ...overrides,
  };
}

function publishTo(bus: BusService, topic = "test.input"): void {
  bus.publish({ from: "sender", topic, type: "text", criticality: 3, payload: { content: "hello" } });
}

/** Poll until condition is true or timeout. */
async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => { setTimeout(r, intervalMs); });
  }
  return fn();
}

describe("ServiceRunner", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleepService: SleepService;

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
    sleepService = new SleepService(bus, registry);
  });

  afterEach(() => { sleepService.destroy(); });

  it("calls handler when a message arrives", async () => {
    let called = false;
    const handler: NodeHandler = () => { called = true; return Promise.resolve(); };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    expect(await waitFor(() => called)).toBe(true);
    runner.stop();
  });

  it("auto-sleeps after handling", async () => {
    const handler: NodeHandler = () => Promise.resolve();
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    const slept = await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING);
    expect(slept).toBe(true);
    runner.stop();
  });

  it("wakes on new message after auto-sleep", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => { callCount++; return Promise.resolve(); };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService });
    runner.start();

    publishTo(bus);
    await waitFor(() => callCount === 1);

    publishTo(bus);
    const woke = await waitFor(() => callCount === 2);
    expect(woke).toBe(true);
    runner.stop();
  });

  it("does not double-call handler while busy", async () => {
    let callCount = 0;
    const handler: NodeHandler = async () => {
      callCount++;
      await new Promise((r) => { setTimeout(r, 300); });
    };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry, sleepService });
    runner.start();

    publishTo(bus);
    publishTo(bus);
    await new Promise((r) => { setTimeout(r, 100); });

    // While handler is busy, callCount should still be 1
    expect(callCount).toBe(1);
    runner.stop();
  });
});

describe("LLMRunner", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleepService: SleepService;

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
    sleepService = new SleepService(bus, registry);
  });

  afterEach(() => { sleepService.destroy(); });

  it("runs handler up to budget then force-sleeps", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => { callCount++; return Promise.resolve(); };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 3, forced_sleep: "1s" },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    const slept = await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING, 10000);
    expect(slept).toBe(true);
    expect(callCount).toBe(3);
    runner.stop();
  });

  it("resets budget when new message arrives during loop", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => {
      callCount++;
      if (callCount === 2) publishTo(bus); // inject message mid-loop
      return Promise.resolve();
    };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 3, forced_sleep: "1s" },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING, 10000);
    // Budget was reset at call 2, so > 3 total calls
    expect(callCount).toBeGreaterThan(3);
    runner.stop();
  });

  it("respects handler sleep request immediately", async () => {
    let callCount = 0;
    const handler: NodeHandler = (ctx) => {
      callCount++;
      ctx.sleep([{ type: "any" }]);
      return Promise.resolve();
    };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 5, forced_sleep: "1s" },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    const slept = await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING);
    expect(slept).toBe(true);
    expect(callCount).toBe(1); // stopped after first call
    runner.stop();
  });

  it("injects budget info into ctx.state", async () => {
    let capturedState: Record<string, unknown> = {};
    const handler: NodeHandler = (ctx) => {
      capturedState = { ...ctx.state };
      ctx.sleep([{ type: "any" }]);
      return Promise.resolve();
    };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 5 },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry, sleepService });
    runner.start();
    publishTo(bus);

    await waitFor(() => registry.get(node.id)?.state === NodeState.SLEEPING);

    expect(capturedState._iteration).toBe(1);
    expect(capturedState._iterations_remaining).toBe(5);
    expect(capturedState._iterations_total).toBe(5);
    expect(typeof capturedState._system_hint).toBe("string");
    runner.stop();
  });
});
