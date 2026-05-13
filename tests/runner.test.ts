import { describe, it, expect, beforeEach } from "vitest";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { LLMRunner } from "../packages/core/src/runner/llm-runner";
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

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
  });

  it("calls handler when a message arrives", async () => {
    let called = false;
    const handler: NodeHandler = () => { called = true; return Promise.resolve(); };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry });
    runner.start();
    publishTo(bus);

    expect(await waitFor(() => called)).toBe(true);
    runner.stop();
  });

  it("runs handler exactly once per incoming message", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => { callCount++; return Promise.resolve(); };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry });
    runner.start();
    publishTo(bus);

    expect(await waitFor(() => callCount === 1)).toBe(true);
    // After handler returns the runner auto-parks; callCount must not climb on its own.
    await new Promise((r) => { setTimeout(r, 200); });
    expect(callCount).toBe(1);
    runner.stop();
  });

  it("re-runs handler when a new message arrives after parking", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => { callCount++; return Promise.resolve(); };
    const node = makeNodeInfo();
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new ServiceRunner(node, handler, { bus, registry });
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

    const runner = new ServiceRunner(node, handler, { bus, registry });
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

  beforeEach(() => {
    bus = new BusService();
    registry = new InstanceRegistry();
  });

  it("runs handler up to budget then parks", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => { callCount++; return Promise.resolve(); };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 3 },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry });
    runner.start();
    // Publish 3 messages — the budget loop should consume each as
    // they're available and stop at the budget cap (or empty mailbox).
    publishTo(bus);
    publishTo(bus);
    publishTo(bus);

    expect(await waitFor(() => callCount >= 1, 10000)).toBe(true);
    // After parking, callCount must not exceed the budget.
    await new Promise((r) => { setTimeout(r, 200); });
    expect(callCount).toBeLessThanOrEqual(3);
    runner.stop();
  });

  it("resets budget when new message arrives during loop", async () => {
    let callCount = 0;
    const handler: NodeHandler = () => {
      callCount++;
      // Each iteration re-feeds the mailbox so the budget never
      // shrinks; the loop should still cap at max_iterations.
      if (callCount < 5) publishTo(bus);
      return Promise.resolve();
    };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 3 },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry });
    runner.start();
    publishTo(bus);

    // Loop runs up to max_iterations per wake; if budget were *not*
    // being reset when new messages land, the run would cap at 3.
    // Each handler call publishes a fresh message before returning,
    // so budget keeps resetting and callCount climbs past 3.
    await waitFor(() => callCount > 3, 10000);
    expect(callCount).toBeGreaterThan(3);
    runner.stop();
  });

  it("injects budget info into ctx.state", async () => {
    let capturedState: Record<string, unknown> = {};
    const handler: NodeHandler = (ctx) => {
      if (Object.keys(capturedState).length === 0) capturedState = { ...ctx.state };
      return Promise.resolve();
    };
    const node = makeNodeInfo({
      tags: ["llm"],
      config_overrides: { max_iterations: 5 },
    });
    registry.add(node);
    bus.subscribe(node.id, "test.input");

    const runner = new LLMRunner(node, handler, { bus, registry });
    runner.start();
    publishTo(bus);

    await waitFor(() => Object.keys(capturedState).length > 0);

    expect(capturedState._iteration).toBe(1);
    expect(capturedState._iterations_remaining).toBe(5);
    expect(capturedState._iterations_total).toBe(5);
    expect(typeof capturedState._system_hint).toBe("string");
    runner.stop();
  });
});
