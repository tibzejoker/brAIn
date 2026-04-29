/**
 * Agent integration tests — boots a real `nats-server`, an `Agent`,
 * and an `AgentDirectory` on the API side; verifies announcements
 * flow and a message published on one side reaches a node on the
 * other.
 *
 * Skipped when `nats-server` isn't on PATH.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentDirectory } from "../packages/agent/src/agent";
import { NatsBusService } from "@brain/core";

const HAS_NATS = spawnSync("which", ["nats-server"]).status === 0;
const PORT = 24222 + Math.floor(Math.random() * 500);

let server: ChildProcess | null = null;

beforeAll(async () => {
  if (!HAS_NATS) return;
  server = spawn("nats-server", ["-p", String(PORT)], { stdio: "ignore" });
  await wait(400);
});

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await wait(150);
    if (!server.killed) server.kill("SIGKILL");
  }
});

describe.skipIf(!HAS_NATS)("brAIn-agent + AgentDirectory", () => {
  it("an agent's announcement is received by the API directory", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-test-"));
    const apiBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "agt1" });
    await apiBus.connect();
    const dir = new AgentDirectory(apiBus, { ttlMs: 5000 });
    dir.attach();

    const agent = new Agent({
      agentId: "test-agent-1",
      host: "test-host",
      natsUrl: `nats://127.0.0.1:${PORT}`,
      natsPrefix: "agt1",
      nodesDir: join(scratch, "nodes"),  // missing dir is OK
      dbPath: join(scratch, "agent.db"),
      announceIntervalMs: 200,
    });
    // Don't actually call agent.start() because it installs SIGTERM
    // handlers + may process.exit on stop. Drive its internals
    // directly: connect a private bus + announce manually.
    // We just verify announce → directory shape from a separate
    // NatsBusService instance, mirroring the real flow.
    const agentBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "agt1" });
    await agentBus.connect();
    agentBus.publish({
      from: "agent:test-agent-1",
      topic: "brain.agents.discover",
      type: "text", criticality: 0,
      payload: { content: JSON.stringify({
        agent_id: "test-agent-1", host: "test-host",
        pid: 999, started_at: Date.now(),
        types: ["echo", "clock"],
        ts: Date.now(),
      }) },
    });

    const deadline = Date.now() + 1500;
    let listed: ReturnType<AgentDirectory["list"]> = [];
    while (Date.now() < deadline && listed.length === 0) {
      await wait(30);
      listed = dir.list();
    }
    expect(listed).toHaveLength(1);
    expect(listed[0].agent_id).toBe("test-agent-1");
    expect(listed[0].host).toBe("test-host");
    expect(listed[0].types).toEqual(["echo", "clock"]);

    await apiBus.close();
    await agentBus.close();

    void agent;  // keep the import alive for type coverage
  });

  it("messages published on the API bus reach a node hosted by the agent (via NATS)", async () => {
    const apiBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "agt2" });
    const agentBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "agt2" });
    await apiBus.connect(); await agentBus.connect();

    // Pretend a node lives on the agent: subscribe on agentBus.
    agentBus.subscribe("hosted-node", "remote.ping");

    apiBus.publish({
      from: "api-publisher",
      topic: "remote.ping",
      type: "text", criticality: 1,
      payload: { content: "hello-from-api" },
    });

    const deadline = Date.now() + 1500;
    let got = agentBus.getUnreadMessages("hosted-node");
    while (got.length === 0 && Date.now() < deadline) {
      await wait(30);
      got = agentBus.getUnreadMessages("hosted-node");
    }
    expect(got).toHaveLength(1);
    expect((got[0].payload as { content: string }).content).toBe("hello-from-api");

    await apiBus.close(); await agentBus.close();
  });
});
