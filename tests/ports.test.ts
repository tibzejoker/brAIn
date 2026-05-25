/**
 * Tests for the 2-layer wiring model (ports + bindings).
 *
 * Three concentric scopes — each layer tested where it actually lives:
 *
 *   1. ports.ts — pure helpers that translate between the declarative
 *      port layer and the flat subscription layer the bus understands.
 *      Tested as plain functions: in / out, no I/O.
 *
 *   2. tool-catalog.ts — surfaces ports to MCP. Two pitfalls covered:
 *      wildcard bindings (the bus subscribes broadly but an MCP client
 *      can't publish on `alerts.*`, so the catalog must synthesise a
 *      concrete subject) and the legacy "flat subs" backward path
 *      (which must not double-expose port-derived rows).
 *
 *   3. context-builder.ts — the runtime side: when a message arrives
 *      on a topic bound to a port, the message must reach the handler
 *      with `msg.port` set; the handler's `ctx.emit_port()` must fan
 *      out across every topic currently wired to that output port.
 *
 * No reliance on the brain node, the LLM, or any storeproject — pure
 * framework. Catches regressions like the one we hit during the
 * "internal tier" refactor where chat.reset stopped being callable.
 */
import { describe, it, expect } from "vitest";
import {
  autoDerivePorts,
  autoDeriveBindings,
  expandPortsToSubs,
  mergePortBindings,
  resolveCallTopic,
  toolsForNode,
  toolDescriptorsForNode,
  federatedTools,
  BusService,
  buildNodeContext,
  NodeLog,
} from "@brain/core";
import { NodeState, type NodeInfo, type Message, type SubscriptionConfig } from "@brain/sdk";

// ---------------------------------------------------------------------------
// 1. ports.ts — pure helpers
// ---------------------------------------------------------------------------

describe("autoDerivePorts", () => {
  it("synthesises a port per default_subscription, keeping its schema", () => {
    const subs: SubscriptionConfig[] = [
      { topic: "chat.input", description: "user text", inputSchema: { type: "string" } },
    ];
    const ports = autoDerivePorts(subs, ["chat.response"]);
    expect(ports.inputs?.["chat.input"]).toEqual({
      description: "user text",
      inputSchema: { type: "string" },
      outputSchema: undefined,
    });
    expect(ports.outputs?.["chat.response"]).toEqual({ description: "chat.response" });
  });

  it("falls back to { type: 'object' } when a legacy internal sub has no schema", () => {
    // `internal:true` subs are allowed to omit inputSchema in the discriminated
    // union. autoDerivePorts must still produce a callable port (no hidden
    // tier any more), so the schema falls back to a permissive object.
    const subs: SubscriptionConfig[] = [
      { topic: "alerts.*", description: "fan-in", internal: true },
    ];
    const ports = autoDerivePorts(subs, undefined);
    expect(ports.inputs?.["alerts.*"]?.inputSchema).toEqual({ type: "object" });
  });
});

describe("autoDeriveBindings", () => {
  it("binds every sub topic to itself (1:1)", () => {
    const subs: SubscriptionConfig[] = [
      { topic: "a", description: "a", inputSchema: { type: "object" } },
      { topic: "b.*", description: "b-fan-in", internal: true },
    ];
    const bindings = autoDeriveBindings(subs, ["c"]);
    expect(bindings.inputs).toEqual({ a: ["a"], "b.*": ["b.*"] });
    expect(bindings.outputs).toEqual({ c: ["c"] });
  });
});

describe("expandPortsToSubs", () => {
  it("emits one public SubscriptionConfig per (port, bound topic), tagging the description", () => {
    const subs = expandPortsToSubs(
      {
        inputs: {
          user_message: {
            description: "user text",
            inputSchema: { type: "string" },
            outputSchema: { type: "object", properties: { ack: { type: "boolean" } } },
          },
        },
      },
      { inputs: { user_message: ["chat.input", "chat.input.alt"] } },
    );
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      topic: "chat.input",
      description: "[port:user_message] user text",
      inputSchema: { type: "string" },
      outputSchema: { type: "object", properties: { ack: { type: "boolean" } } },
    });
    expect(subs[1].topic).toBe("chat.input.alt");
    // Internal flag must NOT be set — every port-expanded sub is callable.
    expect((subs[0] as { internal?: unknown }).internal).toBeUndefined();
  });

  it("returns [] for ports without inputs or bindings", () => {
    expect(expandPortsToSubs(undefined, undefined)).toEqual([]);
    expect(expandPortsToSubs({ inputs: {} }, undefined)).toEqual([]);
  });
});

describe("mergePortBindings", () => {
  it("overrides per-port, keys not in override are preserved", () => {
    const merged = mergePortBindings(
      { inputs: { a: ["t1"], b: ["t2"] } },
      { inputs: { b: ["t2-new", "t3"] } },
    );
    expect(merged.inputs).toEqual({ a: ["t1"], b: ["t2-new", "t3"] });
  });
});

// ---------------------------------------------------------------------------
// 2. tool-catalog.ts — MCP surface
// ---------------------------------------------------------------------------

describe("resolveCallTopic", () => {
  it("uses the first concrete bound topic", () => {
    expect(resolveCallTopic("user_message", ["chat.input"])).toBe("chat.input");
    expect(resolveCallTopic("alarm_set", ["Alarm.set", "Alarm.snooze"])).toBe("Alarm.set");
  });

  it("prefers concrete over wildcard when both are bound", () => {
    expect(resolveCallTopic("alert", ["alerts.*", "alerts.from_mcp"])).toBe("alerts.from_mcp");
  });

  it("synthesises a concrete subject from a single-level wildcard binding", () => {
    // `alerts.*` is not a valid NATS publish subject; the catalog must
    // give MCP clients something they CAN publish on. Replacing the `*`
    // segment with the port name keeps the broad subscription matching
    // it (a sub on `alerts.*` still receives `alerts.alert`).
    expect(resolveCallTopic("alert", ["alerts.*"])).toBe("alerts.alert");
    expect(resolveCallTopic("addressed_message", ["brain.*"])).toBe("brain.addressed_message");
  });

  it("handles `>` (multi-segment) wildcards too", () => {
    expect(resolveCallTopic("event", ["events.>"])).toBe("events.event");
  });

  it("falls back to the port name when there are zero bindings", () => {
    expect(resolveCallTopic("orphan_port", [])).toBe("orphan_port");
  });
});

function nodeFixture(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "n1",
    type: "test",
    name: "test-instance",
    description: "fixture",
    tags: [],
    authority_level: 0,
    state: NodeState.ACTIVE,
    priority: 1,
    subscriptions: [],
    transport: "process",
    position: { x: 0, y: 0 },
    created_at: 0,
    ...overrides,
  };
}

describe("toolsForNode", () => {
  it("exposes every declared input port as an MCP tool (no internal tier)", () => {
    const node = nodeFixture({
      ports: {
        inputs: {
          user_message: { description: "user text", inputSchema: { type: "string" } },
          reset_signal: { description: "wipe context", inputSchema: { type: "object" } },
        },
        outputs: { user_response: { description: "reply" } },
      },
      port_bindings: {
        inputs: { user_message: ["chat.input"], reset_signal: ["chat.reset"] },
        outputs: { user_response: ["chat.response"] },
      },
    });
    const tools = toolsForNode(node);
    expect(tools.map((t) => t.name).sort()).toEqual(["reset_signal", "user_message"]);
    expect(tools.find((t) => t.name === "user_message")?.topic).toBe("chat.input");
    expect(tools.find((t) => t.name === "reset_signal")?.topic).toBe("chat.reset");
  });

  it("uses synthesised concrete topic for wildcard-only port bindings", () => {
    const node = nodeFixture({
      ports: {
        inputs: { alert: { description: "alert fan-in", inputSchema: { type: "object" } } },
      },
      port_bindings: { inputs: { alert: ["alerts.*"] } },
    });
    const tools = toolsForNode(node);
    expect(tools).toHaveLength(1);
    expect(tools[0].topic).toBe("alerts.alert");
  });

  it("does not double-expose a topic that's both port-bound and present in legacy subs", () => {
    // expandPortsToSubs tags the description with `[port:…]`; toolsForNode
    // uses that prefix as the dedupe signal so we don't surface the same
    // capability twice when the runtime carries both forms during migration.
    const node = nodeFixture({
      ports: {
        inputs: { user_message: { description: "user text", inputSchema: { type: "string" } } },
      },
      port_bindings: { inputs: { user_message: ["chat.input"] } },
      subscriptions: [
        // What expandPortsToSubs produced + saved on the live NodeInfo.
        {
          topic: "chat.input",
          description: "[port:user_message] user text",
          inputSchema: { type: "string" },
        },
      ],
    });
    const tools = toolsForNode(node);
    expect(tools).toHaveLength(1); // not 2
    expect(tools[0].name).toBe("user_message");
  });
});

describe("toolDescriptorsForNode (shared by /tools + ctx.tools.list)", () => {
  it("uses the synthesised topic, not the wildcard, on the descriptor", () => {
    // This is the actual regression — `/tools` and `ctx.tools.list()`
    // were walking node.subscriptions directly and surfacing wildcards
    // as call subjects. After the fix they both delegate here.
    const node = nodeFixture({
      ports: {
        inputs: { alert: { description: "fan-in", inputSchema: { type: "object" } } },
      },
      port_bindings: { inputs: { alert: ["alerts.*"] } },
      subscriptions: [
        // expandPortsToSubs result kept on the live NodeInfo.
        { topic: "alerts.*", description: "[port:alert] fan-in", inputSchema: { type: "object" } },
      ],
    });
    const desc = toolDescriptorsForNode(node);
    expect(desc).toHaveLength(1);
    expect(desc[0].topic).toBe("alerts.alert");
    expect(desc[0].description).toBe("fan-in"); // port description, not the `[port:…]` prefixed sub
  });

  it("skips port-derived subs (description starts with [port:) to avoid doublons", () => {
    const node = nodeFixture({
      ports: {
        inputs: { user_message: { description: "user text", inputSchema: { type: "string" } } },
      },
      port_bindings: { inputs: { user_message: ["chat.input"] } },
      subscriptions: [
        { topic: "chat.input", description: "[port:user_message] user text", inputSchema: { type: "string" } },
      ],
    });
    expect(toolDescriptorsForNode(node)).toHaveLength(1);
  });

  it("still surfaces a non-port-bound public sub (legacy migration window)", () => {
    const node = nodeFixture({
      // No ports declared — node hasn't migrated.
      subscriptions: [
        { topic: "legacy.cmd", description: "old-style sub", inputSchema: { type: "object" } },
      ],
    });
    const desc = toolDescriptorsForNode(node);
    expect(desc).toHaveLength(1);
    expect(desc[0].topic).toBe("legacy.cmd");
  });
});

describe("federatedTools", () => {
  it("namespaces by node name and uses synthesised topics on wildcards", () => {
    const brain = nodeFixture({
      id: "b", name: "consciousness",
      ports: {
        inputs: { alert: { description: "alert fan-in", inputSchema: { type: "object" } } },
      },
      port_bindings: { inputs: { alert: ["alerts.*"] } },
    });
    const tools = federatedTools([brain]);
    expect(tools[0].name).toBe("consciousness__alert");
    expect(tools[0].topic).toBe("alerts.alert");
  });
});

// ---------------------------------------------------------------------------
// 3. context-builder.ts — runtime tagging + emit_port fan-out
// ---------------------------------------------------------------------------

describe("buildNodeContext — msg.port tagging", () => {
  it("stamps msg.port from the reverse port_bindings index", () => {
    const node = nodeFixture({
      port_bindings: {
        inputs: {
          user_message: ["chat.input"],
          reset_signal: ["chat.reset"],
          alert: ["alerts.*", "alerts.urgent"],
        },
      },
    });
    const bus = new BusService();
    const incoming: Message[] = [
      // Concrete bound topic — should tag.
      { id: "m1", from: "x", topic: "chat.input", type: "text", criticality: 1, payload: { content: "hi" }, timestamp: 0 },
      // Different bound topic, different port.
      { id: "m2", from: "x", topic: "chat.reset", type: "text", criticality: 1, payload: { content: "" }, timestamp: 0 },
      // Bound to the alert port (concrete sibling of the wildcard).
      { id: "m3", from: "x", topic: "alerts.urgent", type: "alert", criticality: 8, payload: { title: "t", description: "d" }, timestamp: 0 },
      // Unbound — must NOT be tagged, even if the topic looks port-y.
      { id: "m4", from: "x", topic: "noise.unrelated", type: "text", criticality: 1, payload: { content: "" }, timestamp: 0 },
    ];
    const ctx = buildNodeContext(
      { nodeInfo: node, state: {}, log: new NodeLog(node.id), iteration: 0 },
      { bus },
      incoming,
      new AbortController().signal,
      null,
    );
    expect(ctx.messages.map((m) => [m.id, m.port])).toEqual([
      ["m1", "user_message"],
      ["m2", "reset_signal"],
      ["m3", "alert"],
      ["m4", undefined],
    ]);
  });

  it("does NOT mutate the input messages array (immutability boundary)", () => {
    const node = nodeFixture({ port_bindings: { inputs: { p: ["t"] } } });
    const bus = new BusService();
    const original: Message = { id: "m", from: "x", topic: "t", type: "text", criticality: 1, payload: { content: "" }, timestamp: 0 };
    buildNodeContext(
      { nodeInfo: node, state: {}, log: new NodeLog(node.id), iteration: 0 },
      { bus },
      [original],
      new AbortController().signal,
      null,
    );
    // Caller's original message must still be untouched — the runner
    // re-uses the array across iterations, mutation would leak state.
    expect(original.port).toBeUndefined();
  });
});

describe("buildNodeContext — emit_port fan-out", () => {
  it("publishes on every topic currently wired to the named output port", () => {
    const node = nodeFixture({
      ports: { outputs: { user_response: { description: "reply" } } },
      port_bindings: { outputs: { user_response: ["chat.response", "chat.response.web"] } },
    });
    const bus = new BusService();
    const captured: Message[] = [];
    bus.on("message:published", (m: Message) => { captured.push(m); });
    const ctx = buildNodeContext(
      { nodeInfo: node, state: {}, log: new NodeLog(node.id), iteration: 0 },
      { bus },
      [],
      new AbortController().signal,
      null,
    );
    ctx.emit_port("user_response", { type: "text", criticality: 1, payload: { content: "hello" } });
    expect(captured.map((m) => m.topic).sort()).toEqual(["chat.response", "chat.response.web"]);
    // Every fan-out copy carries the same payload + comes from this node.
    expect(captured.every((m) => m.from === node.id)).toBe(true);
    expect(captured.every((m) => (m.payload as { content: string }).content === "hello")).toBe(true);
  });

  it("drops the emission (no throw, no publish) when the port is undeclared", () => {
    const node = nodeFixture({ ports: { outputs: {} }, port_bindings: { outputs: {} } });
    const bus = new BusService();
    const captured: Message[] = [];
    bus.on("message:published", (m: Message) => { captured.push(m); });
    const ctx = buildNodeContext(
      { nodeInfo: node, state: {}, log: new NodeLog(node.id), iteration: 0 },
      { bus },
      [],
      new AbortController().signal,
      null,
    );
    ctx.emit_port("ghost", { type: "text", criticality: 1, payload: { content: "x" } });
    expect(captured).toHaveLength(0);
  });

  it("drops the emission when the port is declared but has zero bindings (orphan)", () => {
    const node = nodeFixture({
      ports: { outputs: { user_response: { description: "reply" } } },
      port_bindings: { outputs: { user_response: [] } },
    });
    const bus = new BusService();
    const captured: Message[] = [];
    bus.on("message:published", (m: Message) => { captured.push(m); });
    const ctx = buildNodeContext(
      { nodeInfo: node, state: {}, log: new NodeLog(node.id), iteration: 0 },
      { bus },
      [],
      new AbortController().signal,
      null,
    );
    ctx.emit_port("user_response", { type: "text", criticality: 1, payload: { content: "x" } });
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The wildcard regression itself, end-to-end on the bus
// ---------------------------------------------------------------------------

describe("wildcard port: subscribe broadly, call concretely", () => {
  it("a sub on `alerts.*` receives a publish to the resolveCallTopic-synthesised `alerts.alert`", () => {
    // This is the integration claim the catalog rests on. If NATS subject
    // matching ever changed, this test would catch it before the catalog
    // gave MCP clients an unusable handle.
    const bus = new BusService();
    const seen: Message[] = [];
    bus.subscribe("listener", "alerts.*");
    bus.on("message:published", (m: Message) => {
      if (m.topic.startsWith("alerts.")) seen.push(m);
    });
    bus.publish({
      from: "tester",
      topic: resolveCallTopic("alert", ["alerts.*"]),
      type: "alert",
      criticality: 5,
      payload: { title: "x", description: "y" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].topic).toBe("alerts.alert");
  });
});
