/**
 * mcp-host E2E with a real public MCP server.
 *
 * Spawns `npx -y @modelcontextprotocol/server-filesystem <tmpdir>`
 * (a published reference implementation maintained by Anthropic),
 * then drives the brAIn mcp-host node against it: discovery,
 * read_file, write_file, list_directory.
 *
 * Skipped unless RUN_MCP_E2E=1 — the npx download is heavy and the
 * test depends on network access to the npm registry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { BusService } from "@brain/core";
import { ServiceRunner } from "../packages/core/src/runner/service-runner";
import { SleepService } from "../packages/core/src/runner/sleep.service";
import { InstanceRegistry } from "../packages/core/src/registry/instance-registry";
import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, Message } from "@brain/sdk";
import { NodeState } from "@brain/sdk";

const HANDLER_PATH = resolve(__dirname, "..", "nodes", "mcp-host", "dist", "handler.js");

describe.skipIf(!process.env.RUN_MCP_E2E)("mcp-host with @modelcontextprotocol/server-filesystem", () => {
  let bus: BusService;
  let registry: InstanceRegistry;
  let sleep: SleepService;
  let runner: ServiceRunner;
  let teardown: NodeTeardown | undefined;
  let workdir: string;

  beforeAll(async () => {
    if (!existsSync(HANDLER_PATH)) throw new Error(`build mcp-host first (${HANDLER_PATH})`);
    // realpath because macOS tmpdir is /var/folders → /private/var/folders;
    // the MCP filesystem server resolves symlinks before its allow-list
    // check, so we have to do the same here for paths we send it.
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-fs-e2e-")));
    writeFileSync(join(workdir, "hello.txt"), "from brAIn", "utf-8");

    const mod = await import(HANDLER_PATH);
    const handler = mod.handler as NodeHandler;
    const onSpawn = mod.onSpawn as NodeOnSpawn;
    teardown = mod.teardown as NodeTeardown;

    bus = new BusService();
    registry = new InstanceRegistry();
    sleep = new SleepService(bus, registry);

    const node: NodeInfo = {
      id: "mcp-fs-e2e",
      type: "mcp-host", name: "mcp-host", description: "", tags: ["service", "mcp"],
      authority_level: 1, state: NodeState.ACTIVE, priority: 3,
      subscriptions: [{ topic: "mcp.call" }, { topic: "mcp.tools.list" }],
      transport: "process", position: { x: 0, y: 0 },
      config_overrides: {
        response_topic: "mcp.result",
        servers: [
          {
            name: "fs",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", workdir],
          },
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
    // First-time npx download can take 20-40s on a cold cache.
    await wait(20_000);
  }, 90_000);

  afterAll(async () => {
    runner?.stop();
    if (teardown) await teardown();
    sleep?.destroy();
  });

  async function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const witnessId = `witness-${Math.random().toString(36).slice(2, 6)}`;
    bus.subscribe(witnessId, "mcp.result");
    bus.publish({
      from: "tester", topic: "mcp.call",
      type: "text", criticality: 1,
      payload: { content: JSON.stringify({ server, tool, arguments: args }) },
    });
    const t0 = Date.now() + 8000;
    let seen: Message[] = [];
    while (Date.now() < t0 && seen.length === 0) {
      await wait(50);
      seen = bus.getUnreadMessages(witnessId);
    }
    if (seen.length === 0) throw new Error(`mcp.call timeout for ${tool}`);
    return JSON.parse((seen[0].payload as { content: string }).content);
  }

  it("lists the filesystem server's real tools via mcp.tools.list", async () => {
    bus.subscribe("witness-list", "mcp.tools.available");
    bus.publish({
      from: "tester", topic: "mcp.tools.list",
      type: "text", criticality: 1, payload: { content: "" },
    });
    const t0 = Date.now() + 5000;
    let seen: Message[] = [];
    while (Date.now() < t0 && seen.length === 0) {
      await wait(50);
      seen = bus.getUnreadMessages("witness-list");
    }
    expect(seen.length).toBeGreaterThan(0);
    const meta = seen[0].metadata as { tools: Array<{ server: string; name: string }> };
    const fsToolNames = meta.tools.filter((t) => t.server === "fs").map((t) => t.name);
    // Reference server exposes read_file, write_file, list_directory etc.
    expect(fsToolNames.length).toBeGreaterThan(3);
    expect(fsToolNames).toContain("read_file");
  }, 30_000);

  it("read_file returns the test file's content", async () => {
    const result = await callTool("fs", "read_file", { path: join(workdir, "hello.txt") });
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toBe("from brAIn");
  }, 15_000);

  it("write_file followed by read_file roundtrips correctly", async () => {
    const target = join(workdir, "round.txt");
    await callTool("fs", "write_file", { path: target, content: "hello roundtrip" });
    const result = await callTool("fs", "read_file", { path: target });
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toBe("hello roundtrip");
  }, 20_000);
});
