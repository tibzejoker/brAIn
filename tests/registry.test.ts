import { describe, it, expect, beforeEach } from "vitest";
import { TypeRegistry, InstanceRegistry } from "@brain/core";
import { NodeState, AuthorityLevel } from "@brain/sdk";
import * as path from "path";

describe("TypeRegistry", () => {
  it("scans and registers node types from directory", () => {
    const reg = new TypeRegistry();
    const nodesDir = path.resolve(__dirname, "../nodes");
    const types = reg.scanDirectory(nodesDir);

    expect(types.length).toBeGreaterThanOrEqual(5);
    expect(reg.has("clock")).toBe(true);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("cron")).toBe(true);
    expect(reg.has("http-bridge")).toBe(true);
    expect(reg.has("terminal")).toBe(true);
  });

  it("returns type config with description", () => {
    const reg = new TypeRegistry();
    const nodesDir = path.resolve(__dirname, "../nodes");
    reg.scanDirectory(nodesDir);

    const clock = reg.get("clock");
    expect(clock).toBeDefined();
    expect(clock?.description).toContain("time");
    expect(clock?.tags).toContain("utility");
  });

  it("filters by tags", () => {
    const reg = new TypeRegistry();
    const nodesDir = path.resolve(__dirname, "../nodes");
    reg.scanDirectory(nodesDir);

    const llmTypes = reg.list({ tags: ["llm"] });
    expect(llmTypes.length).toBeGreaterThanOrEqual(1);
    expect(llmTypes.every((t) => t.tags.includes("llm"))).toBe(true);
  });
});

describe("InstanceRegistry", () => {
  let reg: InstanceRegistry;

  beforeEach(() => {
    reg = new InstanceRegistry();
  });

  it("adds and retrieves nodes", () => {
    reg.add({
      id: "node-1",
      type: "clock",
      name: "test-clock",
      description: "A test clock",
      tags: ["utility"],
      authority_level: AuthorityLevel.BASIC,
      state: NodeState.ACTIVE,
      priority: 1,
      subscriptions: [],
      transport: "process",
      position: { x: 0, y: 0 },
      created_at: Date.now(),
    });

    expect(reg.count).toBe(1);
    expect(reg.get("node-1")?.name).toBe("test-clock");
  });

  it("updates state and emits event", () => {
    const events: string[] = [];
    reg.on("node:state_changed", () => { events.push("changed"); });

    reg.add({
      id: "node-1",
      type: "echo",
      name: "test",
      description: "Test",
      tags: [],
      authority_level: AuthorityLevel.BASIC,
      state: NodeState.ACTIVE,
      priority: 1,
      subscriptions: [],
      transport: "process",
      position: { x: 0, y: 0 },
      created_at: Date.now(),
    });

    reg.updateState("node-1", NodeState.SLEEPING);
    expect(reg.get("node-1")?.state).toBe(NodeState.SLEEPING);
    expect(events).toHaveLength(1);
  });

  it("filters by state", () => {
    const base = {
      type: "echo",
      description: "Test",
      tags: [],
      authority_level: AuthorityLevel.BASIC as AuthorityLevel,
      priority: 1,
      subscriptions: [] as [],
      transport: "process" as const,
      position: { x: 0, y: 0 },
      created_at: Date.now(),
    };

    reg.add({ ...base, id: "1", name: "active-node", state: NodeState.ACTIVE });
    reg.add({ ...base, id: "2", name: "sleeping-node", state: NodeState.SLEEPING });

    expect(reg.list({ state: NodeState.ACTIVE })).toHaveLength(1);
    expect(reg.list({ state: NodeState.SLEEPING })).toHaveLength(1);
    expect(reg.list()).toHaveLength(2);
  });

  it("finds by text query", () => {
    reg.add({
      id: "1",
      type: "clock",
      name: "main-clock",
      description: "Clock node",
      tags: ["utility", "time"],
      authority_level: AuthorityLevel.BASIC,
      state: NodeState.ACTIVE,
      priority: 1,
      subscriptions: [],
      transport: "process",
      position: { x: 0, y: 0 },
      created_at: Date.now(),
    });

    expect(reg.find("clock")).toHaveLength(1);
    expect(reg.find("time")).toHaveLength(1);
    expect(reg.find("nonexistent")).toHaveLength(0);
  });
});
