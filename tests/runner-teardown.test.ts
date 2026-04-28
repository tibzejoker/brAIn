/**
 * Runner teardown tests.
 *
 * Validates that the optional NodeTeardown is called exactly once when a
 * runner is stopped — covering the "no orphan child process" guarantee
 * at the brAIn layer (the actual SIGTERM/SIGKILL semantics live in
 * child-server.test.ts).
 */
import { describe, it, expect } from "vitest";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

function makeNode(): NodeInfo {
  return {
    id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "test", name: "test", description: "", tags: [],
    authority_level: 0, state: NodeState.ACTIVE, priority: 3,
    subscriptions: [{ topic: "t.in" }],
    transport: "process", position: { x: 0, y: 0 },
    config_overrides: {}, default_publishes: ["t.out"],
    created_at: Date.now(),
  };
}

function makeDeps(): { bus: BusService; registry: InstanceRegistry; sleepService: SleepService } {
  const bus = new BusService();
  const registry = new InstanceRegistry();
  return { bus, registry, sleepService: new SleepService(bus, registry) };
}

const noopHandler: NodeHandler = (): Promise<void> => Promise.resolve();

describe("BaseRunner teardown", () => {
  it("calls teardown on stop()", async () => {
    let called = 0;
    const teardown: NodeTeardown = (): void => { called++; };

    const deps = makeDeps();
    const node = makeNode();
    const runner = new ServiceRunner(node, noopHandler, deps, "auto", teardown);
    runner.start();
    runner.stop();

    // Teardown is fire-and-forget. Yield to let the microtask run.
    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it("awaits async teardowns without blocking stop()", async () => {
    let resolved = false;
    let stopReturned = false;
    const teardown: NodeTeardown = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    };

    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", teardown);
    runner.start();
    runner.stop();
    stopReturned = true;

    // stop() returns synchronously; teardown finishes later.
    expect(stopReturned).toBe(true);
    expect(resolved).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(true);
  });

  it("logs and continues when teardown throws", async () => {
    const deps = makeDeps();
    const teardown: NodeTeardown = (): never => { throw new Error("kaboom"); };
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", teardown);
    runner.start();
    expect(() => runner.stop()).not.toThrow();

    // Drain microtasks so the rejection lands in the runner's catch.
    await new Promise((r) => setTimeout(r, 10));

    const errLogs = runner.getLogs().filter((l) => l.level === "error");
    expect(errLogs.some((l) => l.message.includes("teardown failed"))).toBe(true);
  });

  it("is a no-op when no teardown is provided", () => {
    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto");
    runner.start();
    expect(() => runner.stop()).not.toThrow();
  });

  it("only fires once even if stop() is called repeatedly", async () => {
    let called = 0;
    const teardown: NodeTeardown = (): void => { called++; };

    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", teardown);
    runner.start();
    runner.stop();
    runner.stop();  // duplicate kill — must not double-fire teardown
    runner.stop();

    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(1);
  });
});

describe("BaseRunner onSpawn", () => {
  it("fires onSpawn on start()", async () => {
    let called = 0;
    const onSpawn: NodeOnSpawn = (): void => { called++; };

    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", undefined, onSpawn);
    runner.start();

    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(1);

    runner.stop();
  });

  it("only fires once across multiple start() calls", async () => {
    let called = 0;
    const onSpawn: NodeOnSpawn = (): void => { called++; };

    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", undefined, onSpawn);
    runner.start();
    runner.start();  // restart-style invocation should NOT double-spawn

    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(1);

    runner.stop();
  });

  it("logs and continues when onSpawn throws", async () => {
    const onSpawn: NodeOnSpawn = (): never => { throw new Error("boom"); };

    const deps = makeDeps();
    const runner = new ServiceRunner(makeNode(), noopHandler, deps, "auto", undefined, onSpawn);
    expect(() => runner.start()).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));

    const errLogs = runner.getLogs().filter((l) => l.level === "error");
    expect(errLogs.some((l) => l.message.includes("onSpawn failed"))).toBe(true);

    runner.stop();
  });

  it("re-fires for a fresh runner instance (mirrors a new spawn after kill)", async () => {
    let called = 0;
    const onSpawn: NodeOnSpawn = (): void => { called++; };

    const deps = makeDeps();
    const r1 = new ServiceRunner(makeNode(), noopHandler, deps, "auto", undefined, onSpawn);
    r1.start();
    r1.stop();
    await Promise.resolve();

    const r2 = new ServiceRunner(makeNode(), noopHandler, deps, "auto", undefined, onSpawn);
    r2.start();
    r2.stop();
    await Promise.resolve();
    await Promise.resolve();

    // Each new runner = a new spawn, so onSpawn should run twice total.
    expect(called).toBe(2);
  });
});
