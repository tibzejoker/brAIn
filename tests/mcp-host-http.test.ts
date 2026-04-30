/**
 * mcp-host with the Streamable HTTP transport.
 *
 * Spawns `tests/fixtures/mcp-http-server.mjs` as a child process
 * (a stateless Streamable-HTTP MCP server exposing a `ping` tool),
 * then drives the brAIn mcp-host node configured with
 * `transport: "http"` against it. Validates that the non-stdio path
 * works end-to-end: connect, list tools, call tool over HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, Message } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

const HANDLER_PATH = resolve(__dirname, "..", "nodes", "mcp-host", "dist", "handler.js");
const FIXTURE = resolve(__dirname, "fixtures", "mcp-http-server.mjs");
const PORT = 31000 + Math.floor(Math.random() * 500);

let httpServer: ChildProcess | null = null;
let runner: ServiceRunner | null = null;
let teardown: NodeTeardown | undefined;
let bus: BusService;
let sleep: SleepService;

beforeAll(async () => {
  if (!existsSync(HANDLER_PATH)) throw new Error(`build mcp-host first (${HANDLER_PATH})`);

  // 1. Boot the HTTP fixture, wait for it to listen.
  httpServer = spawn(process.execPath, [FIXTURE, String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolveReady, rejectReady) => {
    const t = setTimeout(() => rejectReady(new Error("HTTP fixture timeout")), 5000);
    httpServer?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) { clearTimeout(t); resolveReady(); }
    });
    httpServer?.on("error", rejectReady);
  });

  // 2. Boot mcp-host configured for the http transport.
  const mod = await import(HANDLER_PATH);
  const handler = mod.handler as NodeHandler;
  const onSpawn = mod.onSpawn as NodeOnSpawn;
  teardown = mod.teardown as NodeTeardown;

  bus = new BusService();
  const registry = new InstanceRegistry();
  sleep = new SleepService(bus, registry);

  const node: NodeInfo = {
    id: "mcp-host-http", type: "mcp-host", name: "mcp-host",
    description: "", tags: ["service", "mcp"],
    authority_level: 1, state: NodeState.ACTIVE, priority: 3,
    subscriptions: [{ topic: "mcp.call" }, { topic: "mcp.tools.list" }],
    transport: "process", position: { x: 0, y: 0 },
    config_overrides: {
      response_topic: "mcp.result",
      servers: [
        { name: "http-test", transport: "http", url: `http://127.0.0.1:${PORT}/mcp` },
      ],
    },
    default_publishes: ["mcp.result", "mcp.tools.available"],
    created_at: Date.now(),
  };
  registry.add(node);
  bus.subscribe(node.id, "mcp.call");
  bus.subscribe(node.id, "mcp.tools.list");

  runner = new ServiceRunner(node, handler, { bus, registry, sleepService: sleep }, "auto", teardown, onSpawn);
  runner.start();
  await wait(2000);
}, 15_000);

afterAll(async () => {
  runner?.stop();
  if (teardown) await teardown();
  sleep?.destroy();
  if (httpServer && !httpServer.killed) {
    httpServer.kill("SIGTERM");
    await wait(150);
    if (!httpServer.killed) httpServer.kill("SIGKILL");
  }
});

describe("mcp-host (Streamable HTTP transport)", () => {
  it("discovers the http server's tools", async () => {
    bus.subscribe("witness", "mcp.tools.available");
    bus.publish({
      from: "tester", topic: "mcp.tools.list",
      type: "text", criticality: 1, payload: { content: "" },
    });
    const t0 = Date.now() + 3000;
    let seen: Message[] = [];
    while (Date.now() < t0 && seen.length === 0) {
      await wait(50);
      seen = bus.getUnreadMessages("witness");
    }
    expect(seen.length).toBeGreaterThan(0);
    const meta = seen[0].metadata as { tools: Array<{ server: string; name: string }> };
    expect(meta.tools.some((t) => t.server === "http-test" && t.name === "ping")).toBe(true);
  });

  it("calls a tool over HTTP and returns its content", async () => {
    bus.subscribe("witness2", "mcp.result");
    bus.publish({
      from: "tester", topic: "mcp.call",
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ server: "http-test", tool: "ping", arguments: { text: "hi" } }) },
    });
    const t0 = Date.now() + 3000;
    let seen: Message[] = [];
    while (Date.now() < t0 && seen.length === 0) {
      await wait(50);
      seen = bus.getUnreadMessages("witness2");
    }
    expect(seen.length).toBeGreaterThan(0);
    const body = JSON.parse((seen[0].payload as { content: string }).content);
    expect(body.content?.[0]?.text).toBe("[pong-http] hi");
  });
});
