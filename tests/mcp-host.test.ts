/**
 * mcp-host node — bridges an external MCP server onto the brAIn bus.
 *
 * Spawns a minimal MCP server (`tests/fixtures/mcp-echo-server.mjs`)
 * that exposes one tool "echo", configures the mcp-host node to
 * connect to it via stdio, then asserts:
 *  - `mcp.tools.list` republishes the discovered toolset.
 *  - `mcp.call` with {tool, arguments} returns the tool's content.
 *  - Calling an unknown tool surfaces a structured error, no crash.
 *
 * Skipped when @modelcontextprotocol/sdk isn't installed (it is
 * declared as an mcp-host dep but tests can run in trimmed envs).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, Message } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

const FIXTURE = resolve(__dirname, "fixtures", "mcp-echo-server.mjs");
const HANDLER_PATH = resolve(__dirname, "..", "nodes", "mcp-host", "dist", "handler.js");

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: `mcp-host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "mcp-host", name: "mcp-host", description: "", tags: ["service", "mcp"],
    authority_level: 1, state: NodeState.ACTIVE, priority: 3,
    subscriptions: [{ topic: "mcp.call" }, { topic: "mcp.tools.list" }],
    transport: "process", position: { x: 0, y: 0 },
    config_overrides: {
      response_topic: "mcp.result",
      servers: [
        { name: "test", command: process.execPath, args: [FIXTURE] },
      ],
    },
    default_publishes: ["mcp.result", "mcp.tools.available"],
    created_at: Date.now(),
    ...overrides,
  };
}

const SDK_AVAILABLE = existsSync(HANDLER_PATH);

describe.skipIf(!SDK_AVAILABLE)("mcp-host node", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleep: SleepService;
  let runner: ServiceRunner;
  let handler: NodeHandler;
  let onSpawn: NodeOnSpawn | undefined;
  let teardown: NodeTeardown | undefined;

  beforeAll(async () => {
    const mod = await import(HANDLER_PATH);
    handler = mod.handler;
    onSpawn = mod.onSpawn;
    teardown = mod.teardown;

    bus = new BusService();
    registry = new InstanceRegistry();
    sleep = new SleepService(bus, registry);

    const node = makeNode();
    registry.add(node);
    bus.subscribe(node.id, "mcp.call");
    bus.subscribe(node.id, "mcp.tools.list");

    runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep }, "auto", teardown, onSpawn);
    runner.start();
    // Give the child server time to spawn + listTools to come back.
    await wait(2500);
  }, 15_000);

  afterAll(async () => {
    runner.stop();
    if (teardown) await teardown();
    sleep.destroy();
  });

  it("discovers tools from the connected MCP server via mcp.tools.list", async () => {
    bus.subscribe("witness", "mcp.tools.available");
    bus.publish({
      from: "tester", topic: "mcp.tools.list",
      type: "text", criticality: 1, payload: { content: "" },
    });

    const seen: Message[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && seen.length === 0) {
      await wait(50);
      seen.push(...bus.getUnreadMessages("witness"));
    }
    expect(seen.length).toBeGreaterThan(0);
    const meta = seen[0].metadata as { tools: Array<{ server: string; name: string }> } | undefined;
    expect(meta?.tools.some((t) => t.server === "test" && t.name === "echo")).toBe(true);
  });

  it("calls a tool via mcp.call and returns its content on mcp.result", async () => {
    bus.subscribe("witness2", "mcp.result");
    bus.publish({
      from: "tester", topic: "mcp.call",
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ server: "test", tool: "echo", arguments: { text: "hello" } }) },
    });

    const seen: Message[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && seen.length === 0) {
      await wait(50);
      seen.push(...bus.getUnreadMessages("witness2"));
    }
    expect(seen.length).toBeGreaterThan(0);
    const body = JSON.parse((seen[0].payload as { content: string }).content);
    expect(body.content?.[0]?.text).toBe("[echo] hello");
  });

  it("returns a structured error for an unknown tool, no crash", async () => {
    bus.subscribe("witness3", "mcp.result");
    bus.publish({
      from: "tester", topic: "mcp.call",
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ server: "test", tool: "nonexistent" }) },
    });

    const seen: Message[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && seen.length === 0) {
      await wait(50);
      seen.push(...bus.getUnreadMessages("witness3"));
    }
    expect(seen.length).toBeGreaterThan(0);
    const body = JSON.parse((seen[0].payload as { content: string }).content);
    expect(typeof body.error).toBe("string");
  });
});
