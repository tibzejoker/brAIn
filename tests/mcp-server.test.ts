/**
 * mcp-server node — bridges ONE external MCP server onto the brAIn
 * bus, exposing each tool as its own subscription topic.
 *
 * Spawns the minimal `tests/fixtures/mcp-echo-server.mjs` (one tool
 * "echo"), configures an mcp-server node with `{alias: "test", spec:
 * {command, args}}`, then asserts:
 *  - After connect, the node subscribes to `mcp.test.echo`.
 *  - Publishing on `mcp.test.echo` runs the tool and replies on
 *    `mcp.test.echo.result` with the tool's content.
 *  - `mcp.test.tools.request` republishes the discovered toolset.
 *  - `mcp.test.status.request` republishes the connection snapshot.
 *
 * Skipped when @modelcontextprotocol/sdk isn't installed (it is
 * declared as an mcp-server dep but tests can run in trimmed envs).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, Message } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

const FIXTURE = resolve(__dirname, "fixtures", "mcp-echo-server.mjs");
const HANDLER_PATH = resolve(__dirname, "..", "nodes", "mcp-server", "dist", "handler.js");

function makeNode(alias: string, overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: `mcp-server-${alias}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "mcp-server", name: `mcp-${alias}`, description: "", tags: ["service", "mcp"],
    authority_level: 0, state: NodeState.ACTIVE, priority: 3,
    subscriptions: [],
    transport: "process", position: { x: 0, y: 0 },
    config_overrides: {
      alias,
      spec: { command: process.execPath, args: [FIXTURE] },
    },
    default_publishes: [],
    created_at: Date.now(),
    ...overrides,
  };
}

const SDK_AVAILABLE = existsSync(HANDLER_PATH);

describe.skipIf(!SDK_AVAILABLE)("mcp-server node", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let runner: ServiceRunner;
  let handler: NodeHandler;
  let onSpawn: NodeOnSpawn | undefined;
  let teardown: NodeTeardown | undefined;
  let nodeInfo: NodeInfo;

  beforeAll(async () => {
    const mod = await import(HANDLER_PATH);
    handler = mod.handler;
    onSpawn = mod.onSpawn;
    teardown = mod.teardown;

    bus = new BusService();
    registry = new InstanceRegistry();

    nodeInfo = makeNode("test");
    registry.add(nodeInfo);

    runner = new ServiceRunner(nodeInfo, handler, { bus, registry }, "auto", teardown, onSpawn);
    runner.start();
    // Give onSpawn + first-tick connect + listTools time to complete.
    await wait(2500);
  }, 15_000);

  afterAll(async () => {
    runner.stop();
    if (teardown) await teardown(nodeInfo);
  });

  function collect(witnessId: string, topic: string, ms = 3000): Promise<Message[]> {
    bus.subscribe(witnessId, topic);
    return (async () => {
      const seen: Message[] = [];
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && seen.length === 0) {
        await wait(50);
        seen.push(...bus.getUnreadMessages(witnessId));
      }
      return seen;
    })();
  }

  it("auto-subscribes to mcp.<alias>.<tool> for every discovered tool", () => {
    const subs = bus.getSubscriptions(nodeInfo.id).map((s) => s.pattern);
    expect(subs).toContain("mcp.test.echo");
  });

  it("calls a tool via mcp.<alias>.<tool> and replies on .result", async () => {
    const seenP = collect("witness-call", "mcp.test.echo.result");
    bus.publish({
      from: "tester", topic: "mcp.test.echo",
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ text: "hello" }) },
    });
    const seen = await seenP;
    expect(seen.length).toBeGreaterThan(0);
    const body = JSON.parse((seen[0].payload as { content: string }).content) as { content?: Array<{ text?: string }> };
    expect(body.content?.[0]?.text).toBe("[echo] hello");
  });

  it("republishes the toolset on mcp.<alias>.tools when asked", async () => {
    const seenP = collect("witness-tools", "mcp.test.tools");
    bus.publish({
      from: "tester", topic: "mcp.test.tools.request",
      type: "text", criticality: 1, payload: { content: "" },
    });
    const seen = await seenP;
    expect(seen.length).toBeGreaterThan(0);
    const meta = seen[0].metadata as { alias?: string; tools?: Array<{ name: string }> } | undefined;
    expect(meta?.alias).toBe("test");
    expect(meta?.tools?.some((t) => t.name === "echo")).toBe(true);
  });

  it("republishes status on mcp.<alias>.status when asked", async () => {
    const seenP = collect("witness-status", "mcp.test.status");
    bus.publish({
      from: "tester", topic: "mcp.test.status.request",
      type: "text", criticality: 1, payload: { content: "" },
    });
    const seen = await seenP;
    expect(seen.length).toBeGreaterThan(0);
    const meta = seen[0].metadata as { alias?: string; status?: string; toolCount?: number } | undefined;
    expect(meta?.alias).toBe("test");
    expect(meta?.status).toBe("connected");
    expect(meta?.toolCount).toBeGreaterThan(0);
  });

  it("two mcp-server instances in the same process keep independent connections", async () => {
    // Regression guard for the per-nodeId Map. Spin up a second
    // instance with a different alias and verify both are alive
    // and addressable on their own topics, then teardown one and
    // confirm the other survives.
    const node2 = makeNode("test2");
    registry.add(node2);
    const runner2 = new ServiceRunner(node2, handler, { bus, registry }, "auto", teardown, onSpawn);
    runner2.start();
    await wait(2500);

    const mod = await import(HANDLER_PATH);
    const snap1 = mod.getServerSnapshot(nodeInfo.id);
    const snap2 = mod.getServerSnapshot(node2.id);
    expect(snap1?.alias).toBe("test");
    expect(snap1?.status).toBe("connected");
    expect(snap2?.alias).toBe("test2");
    expect(snap2?.status).toBe("connected");

    runner2.stop();
    if (teardown) await teardown(node2);

    const snap1After = mod.getServerSnapshot(nodeInfo.id);
    const snap2After = mod.getServerSnapshot(node2.id);
    expect(snap1After?.status).toBe("connected");
    expect(snap2After).toBeNull();
  }, 15_000);
});
