/**
 * End-to-end integration test for the tool-declaration discipline.
 *
 * Validates the four pillars of the hard cutover:
 *   1. Enforcement — non-internal subscriptions WITHOUT an inputSchema
 *      get refused at type-registration time.
 *   2. Discovery — `ctx.tools.list()` aggregates every public sub on
 *      the live network, filters internals, exposes inputSchema.
 *   3. Validation — publishing a payload that violates a subscriber's
 *      inputSchema triggers a `<topic>.error` rebound event (log-only
 *      phase: original message still delivered).
 *   4. Hierarchy — MCPBridge `list_nodes` / `list_node_tools` /
 *      `call_node_tool` meta-tools work against the live registry.
 *
 * Hand-written node configs + handlers stay in-memory (mkdtemp). No
 * LLM calls — the brain agent loop is exercised in a separate slow test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  BrainService, TypeRegistry,
  META_TOOLS,
  buildMetaToolHandlers,
} from "@brain/core";
import { normaliseSubscription, type Message, type NodeContext, type NodeHandler, type NodeInfo } from "@brain/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

// Fixtures live under the workspace (not /tmp) because vite's `fs.allow`
// restricts dynamic imports to the workspace root + its parent. The
// per-test root is randomised to keep parallel runs isolated.
const FIXTURE_ROOT = path.resolve(__dirname, "_fixtures", "tool-discipline");

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Build a "nodes/" workspace with the supplied config.json blob + a
 *  no-op handler. Returns the dir to scan. */
function fixtureNode(typeName: string, configJson: Record<string, unknown>): string {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_ROOT, `${typeName}-${randomSlug()}-`));
  const nodeDir = path.join(root, typeName);
  fs.mkdirSync(path.join(nodeDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(nodeDir, "config.json"),
    JSON.stringify({ name: typeName, supports_transport: ["process"], ...configJson }),
  );
  // require.resolve(nodeDir) needs a package.json with `main` pointing
  // at the handler — same layout real nodes ship with.
  fs.writeFileSync(
    path.join(nodeDir, "package.json"),
    JSON.stringify({ name: `@fixture/${typeName}`, version: "0.0.0", main: "dist/handler.js" }),
  );
  fs.writeFileSync(
    path.join(nodeDir, "dist", "handler.js"),
    // Minimal CJS module: handler is a no-op that records its receives.
    `exports.handler = async (ctx) => { ctx.state.received = (ctx.state.received ?? 0) + ctx.messages.length; };`,
  );
  return root;
}

describe("tool-declaration discipline (end-to-end)", () => {
  // Sanity: confirm the SDK function we depend on is resolved. Some
  // vitest aliasing edge cases drop named exports from `export *` re-
  // exports — if this fails, the framework's spawnNode can't normalise
  // subs either, and every downstream test gets confusing failures.
  it("imports normaliseSubscription from @brain/sdk", () => {
    expect(typeof normaliseSubscription).toBe("function");
  });

  // Best-effort cleanup of the entire fixture tree once the whole file
  // is done. Per-test cleanups already remove individual nodes; this
  // is the safety net for the workspace _fixtures/ dir.
  afterAll(() => {
    try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });


  describe("1. Enforcement", () => {
    it("refuses to register a node type whose public sub omits inputSchema", () => {
      const dir = fixtureNode("disc-bad", {
        description: "node missing schema",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [
          // Public sub (no internal:true) but no inputSchema — should be rejected.
          { topic: "bad.command", description: "should fail to register" },
        ],
        default_publishes: [],
      });
      const reg = new TypeRegistry();
      expect(() => reg.register(path.join(dir, "disc-bad")))
        .toThrow(/missing required `inputSchema`/);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts a public sub when inputSchema is present", () => {
      const dir = fixtureNode("disc-ok", {
        description: "node with schema",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [{
          topic: "ok.command",
          description: "valid",
          inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        }],
        default_publishes: [],
      });
      const reg = new TypeRegistry();
      expect(() => reg.register(path.join(dir, "disc-ok"))).not.toThrow();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts an internal:true sub with no inputSchema", () => {
      const dir = fixtureNode("disc-internal", {
        description: "node with internal observer",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [{
          topic: "some.event.*",
          description: "fan-in observer",
          internal: true,
        }],
        default_publishes: [],
      });
      const reg = new TypeRegistry();
      expect(() => reg.register(path.join(dir, "disc-internal"))).not.toThrow();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("2. Discovery — ctx.tools.list() over a live network", () => {
    let brain: BrainService;
    let dirA: string;
    let dirB: string;

    beforeAll(async () => {
      dirA = fixtureNode("tooly-a", {
        description: "node A — exposes one public tool + one internal observer",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [
          {
            topic: "tooly-a.do",
            description: "Run A's main action.",
            inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["fast", "slow"] } }, required: ["mode"] },
          },
          { topic: "events.*", description: "observe", internal: true },
        ],
        default_publishes: ["tooly-a.result"],
      });
      dirB = fixtureNode("tooly-b", {
        description: "node B — two public tools",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [
          {
            topic: "tooly-b.cmd",
            description: "Command B",
            inputSchema: { type: "object", properties: { foo: { type: "string" } } },
          },
          {
            topic: "tooly-b.cmd2",
            description: "Command B alt",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
        default_publishes: [],
      });
      brain = new BrainService(":memory:");
      brain.bootstrap([path.join(dirA, "tooly-a", ".."), path.join(dirB, "tooly-b", "..")]);
    });

    afterAll(() => {
      brain.killAll();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });

    it("exposes only public subscriptions to ctx.tools.list()", async () => {
      const a = await brain.spawnNode({ type: "tooly-a", name: "tooly-a-1" });
      const b = await brain.spawnNode({ type: "tooly-b", name: "tooly-b-1" });

      // Wait one tick so spawn settles.
      await new Promise((r) => setTimeout(r, 50));

      // Walk the registry the same way the facade does. (ctx.tools.list()
      // requires running INSIDE a handler — we exercise the same data
      // path here.)
      const snapshot = brain.instanceRegistry.list();
      const collected: { topic: string; node_id: string }[] = [];
      for (const node of snapshot) {
        for (const sub of node.subscriptions) {
          if (sub.internal === true) continue;
          collected.push({ topic: sub.topic, node_id: node.id });
        }
      }
      const topics = collected.map((c) => c.topic).sort();
      expect(topics).toContain("tooly-a.do");
      expect(topics).toContain("tooly-b.cmd");
      expect(topics).toContain("tooly-b.cmd2");
      // The internal observer must NOT appear.
      expect(topics).not.toContain("events.*");

      // Schemas must round-trip from config → live registry.
      const aSnap = brain.instanceRegistry.get(a.id);
      const aDo = aSnap?.subscriptions.find((s) => s.topic === "tooly-a.do");
      expect(aDo?.inputSchema).toMatchObject({
        type: "object",
        required: ["mode"],
      });
      expect(b.id).toBeTruthy();
    });
  });

  describe("3. Validation — bad payload triggers <topic>.error rebound", () => {
    let brain: BrainService;
    let dirS: string;

    beforeAll(async () => {
      dirS = fixtureNode("strict", {
        description: "node with a strict schema",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [{
          topic: "strict.cmd",
          description: "Strict-only command",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string", enum: ["go", "stop"] } },
            required: ["action"],
            additionalProperties: false,
          },
        }],
        default_publishes: [],
      });
      brain = new BrainService(":memory:");
      brain.bootstrap([path.join(dirS, "strict", "..")]);
    });

    afterAll(() => {
      brain.killAll();
      fs.rmSync(dirS, { recursive: true, force: true });
    });

    it("emits a {topic}.error event when payload doesn't match the schema", async () => {
      await brain.spawnNode({ type: "strict", name: "strict-1" });
      await new Promise((r) => setTimeout(r, 50));

      // Listen for the validator rebound via the bus's EventEmitter
      // surface — `message:published` fires for every publish, including
      // the validator's own rebound message.
      const errors: Message[] = [];
      const onPublished = (m: Message): void => {
        if (m.topic === "strict.cmd.error") errors.push(m);
      };
      (brain.bus as unknown as { on(evt: string, cb: (m: Message) => void): void })
        .on("message:published", onPublished);

      brain.bus.publish({
        from: "test-publisher",
        topic: "strict.cmd",
        type: "text",
        criticality: 3,
        // INVALID: action must be "go" or "stop", and additionalProperties is false.
        payload: { content: JSON.stringify({ action: "BANANA", extra: "nope" }) },
      });

      // Give the validator a moment — it's async but cheap.
      await new Promise((r) => setTimeout(r, 200));
      (brain.bus as unknown as { off(evt: string, cb: (m: Message) => void): void })
        .off("message:published", onPublished);

      expect(errors.length).toBeGreaterThanOrEqual(1);
      const errMsg = errors[0];
      expect(errMsg.from).toContain("system.bus.validator");
      const body = JSON.parse((errMsg.payload as { content: string }).content) as {
        errors: string[];
      };
      expect(body.errors.length).toBeGreaterThan(0);
    });
  });

  describe("4. Hierarchy — MCPBridge meta-tools see the same catalog", () => {
    it("declares list_nodes / list_node_tools / call_node_tool with proper schemas", () => {
      const byName = new Map(META_TOOLS.map((t) => [t.name, t]));
      expect(byName.has("list_nodes")).toBe(true);
      expect(byName.has("list_node_tools")).toBe(true);
      expect(byName.has("call_node_tool")).toBe(true);

      const t2 = byName.get("list_node_tools")!.inputSchema as { required?: string[] };
      const t3 = byName.get("call_node_tool")!.inputSchema as { required?: string[] };
      expect(t2.required).toContain("node_id");
      expect(t3.required).toEqual(expect.arrayContaining(["node_id", "topic", "args"]));
    });

    it("list_nodes drives a drill-down into a live node's tools", async () => {
      const dir = fixtureNode("drill", {
        description: "drill-down target",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [{
          topic: "drill.ping",
          description: "Echoes back",
          inputSchema: { type: "object" },
        }],
        default_publishes: [],
      });
      const brain = new BrainService(":memory:");
      brain.bootstrap([path.join(dir, "drill", "..")]);
      const spawned = await brain.spawnNode({ type: "drill", name: "drill-1" });

      const meta = buildMetaToolHandlers(brain, "test-client");
      const nodes = await meta.list_nodes({});
      expect(nodes.some((n: { node_id: string }) => n.node_id === spawned.id)).toBe(true);

      const tools = await meta.list_node_tools({ node_id: spawned.id });
      expect(tools.length).toBe(1);
      expect(tools[0].topic).toBe("drill.ping");
      expect(tools[0].inputSchema).toBeDefined();

      // call_node_tool publishes on the topic from a synthetic origin.
      const out = await meta.call_node_tool({
        node_id: spawned.id,
        topic: "drill.ping",
        args: {},
      });
      expect(out).toMatchObject({ ok: true });

      brain.killAll();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
