import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { TypeRegistry, InstanceRegistry } from "@brain/core";
import { NodeState, AuthorityLevel } from "@brain/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { allStoreprojectNodeDirs } from "./_helpers/storeprojects-dirs";

function scanAll(reg: TypeRegistry): void {
  for (const dir of allStoreprojectNodeDirs()) reg.scanDirectory(dir);
}

describe("TypeRegistry", () => {
  it("scans and registers node types from directory", () => {
    const reg = new TypeRegistry();
    scanAll(reg);

    // Across all storeprojects, well over 5 types are registered.
    expect(reg.list().length).toBeGreaterThanOrEqual(5);
    expect(reg.has("clock")).toBe(true);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("cron")).toBe(true);
    expect(reg.has("http-bridge")).toBe(true);
    expect(reg.has("terminal")).toBe(true);
  });

  it("returns type config with description", () => {
    const reg = new TypeRegistry();
    scanAll(reg);

    const clock = reg.get("clock");
    expect(clock).toBeDefined();
    expect(clock?.description).toContain("time");
    expect(clock?.tags).toContain("utility");
  });

  it("filters by tags", () => {
    const reg = new TypeRegistry();
    scanAll(reg);

    const llmTypes = reg.list({ tags: ["llm"] });
    expect(llmTypes.length).toBeGreaterThanOrEqual(1);
    expect(llmTypes.every((t) => t.tags.includes("llm"))).toBe(true);
  });

  describe("scanInstalledPackages", () => {
    let scratch: string;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "brain-registry-test-"));
    });

    afterAll(() => {
      // Best-effort cleanup; ignore if a test forgot to set scratch.
      // (Per-test scratch dirs are leaked to /tmp but the OS rotates that.)
    });

    function makePackage(scopeDir: string, name: string, config: Record<string, unknown>): void {
      const pkgDir = path.join(scopeDir, name);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "config.json"), JSON.stringify(config));
    }

    it("registers @brain/node-* packages from node_modules", () => {
      const scope = path.join(scratch, "@brain");
      fs.mkdirSync(scope, { recursive: true });
      makePackage(scope, "node-foo", {
        name: "foo", description: "Foo node", tags: ["test"],
        default_authority: 0, default_priority: 1,
        ports: { outputs: { out: { description: "out" } } },
        default_port_bindings: { outputs: { out: ["test.out"] } },
        supports_transport: ["process"],
      });
      makePackage(scope, "node-bar", {
        name: "bar", description: "Bar node", tags: ["test"],
        default_authority: 0, default_priority: 1,
        ports: { outputs: { out: { description: "out" } } },
        default_port_bindings: { outputs: { out: ["test.out"] } },
        supports_transport: ["process"],
      });
      // A non-node sibling that should be ignored.
      makePackage(scope, "sdk", { name: "sdk-noise" });

      const reg = new TypeRegistry();
      const out = reg.scanInstalledPackages(scratch);
      expect(out.map((t) => t.name).sort()).toEqual(["bar", "foo"]);
      expect(reg.has("foo")).toBe(true);
      expect(reg.has("bar")).toBe(true);
      expect(reg.has("sdk-noise")).toBe(false);
    });

    it("skips entries without config.json", () => {
      const scope = path.join(scratch, "@brain");
      const pkgDir = path.join(scope, "node-empty");
      fs.mkdirSync(pkgDir, { recursive: true });
      // No config.json — should be silently skipped.
      const reg = new TypeRegistry();
      expect(reg.scanInstalledPackages(scratch)).toEqual([]);
    });

    it("returns [] when node_modules has no @brain scope", () => {
      const reg = new TypeRegistry();
      expect(reg.scanInstalledPackages(scratch)).toEqual([]);
    });

    it("can run alongside scanDirectory and merge type sources", () => {
      const scope = path.join(scratch, "@brain");
      fs.mkdirSync(scope, { recursive: true });
      makePackage(scope, "node-from-npm", {
        name: "from-npm", description: "installed", tags: [],
        default_authority: 0, default_priority: 1,
        ports: { outputs: { out: { description: "out" } } },
        default_port_bindings: { outputs: { out: ["test.out"] } },
        supports_transport: ["process"],
      });

      const reg = new TypeRegistry();
      // Pull in-tree types from every storeproject — after the split,
      // `clock` lives in `storeprojects/brAIn-essentials/nodes/clock/`,
      // not in this repo's `nodes/` (which only has `_dynamic/` now).
      scanAll(reg);
      const installed = reg.scanInstalledPackages(scratch);
      expect(installed).toHaveLength(1);
      expect(reg.has("from-npm")).toBe(true);
      expect(reg.has("clock")).toBe(true);  // still has the in-tree types
    });
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
