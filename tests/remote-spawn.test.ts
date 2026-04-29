/**
 * Phase 4.4 — remote spawn end-to-end.
 *
 * Two `BrainService` instances share a real NATS broker:
 *   - "api"   — does the spawning, has no local runner for the node
 *   - "agent" — listens on its agent topic, hosts the runner locally
 *
 * The test asks the api to spawn an `echo` node with
 * `transport: "remote"` and `target_agent_id: "agent-A"`. Then it
 * publishes a message the echo node listens to, and verifies the
 * `echo.output` flows back through NATS.
 *
 * Skipped if `nats-server` isn't on PATH.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrainService, NatsBusService } from "@brain/core";

const HAS_NATS = spawnSync("which", ["nats-server"]).status === 0;
const PORT = 34222 + Math.floor(Math.random() * 500);

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

describe.skipIf(!HAS_NATS)("Remote spawn (transport: remote)", () => {
  it("API dispatches a spawn-request; agent hosts the runner; bus traffic flows end-to-end", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "remote-spawn-"));
    const nodesDir = resolve(__dirname, "..", "nodes");

    // Two NATS-backed buses on the same broker.
    const apiBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "rs" });
    const agentBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "rs" });
    await apiBus.connect();
    await agentBus.connect();

    const api = new BrainService(join(scratch, "api.db"), apiBus);
    api.bootstrap(nodesDir);

    const agent = new BrainService(join(scratch, "agent.db"), agentBus);
    agent.bootstrap(nodesDir);

    // Wire the agent's control channel manually (mirroring what
    // `Agent` does in production code) so this test stays self-
    // contained — no need to spawn the CLI binary.
    const controlNodeId = "agent:agent-A:control";
    agentBus.subscribe(controlNodeId, "brain.agents.agent-A.spawn");
    agentBus.subscribe(controlNodeId, "brain.agents.agent-A.kill");
    agentBus.on(`message:${controlNodeId}`, (msg) => {
      void (async (): Promise<void> => {
        const data = JSON.parse((msg.payload as { content: string }).content);
        if (msg.topic.endsWith(".spawn")) {
          const cfg = { ...data.config, id: data.id, transport: "process" as const };
          await agent.spawnNode(cfg);
        } else if (msg.topic.endsWith(".kill")) {
          agent.killNode(data.node_id);
        }
      })();
    });

    // The API spawns echo with transport=remote → publishes to NATS
    const stub = await api.spawnNode({
      type: "echo",
      name: "echo-on-agent",
      transport: "remote",
      target_agent_id: "agent-A",
      subscriptions: [{ topic: "remote.test.in" }],
    });
    expect(stub.transport).toBe("remote");

    // Wait for the agent to receive + spawn locally
    const deadline1 = Date.now() + 2000;
    while (Date.now() < deadline1 && !agent.instanceRegistry.get(stub.id)) {
      await wait(50);
    }
    const onAgent = agent.instanceRegistry.get(stub.id);
    expect(onAgent).toBeDefined();
    expect(onAgent?.name).toBe("echo-on-agent");

    // Publish on the API bus → echo (on the agent) listens and emits echo.output
    apiBus.publish({
      from: "test-publisher",
      topic: "remote.test.in",
      type: "text", criticality: 1,
      payload: { content: "hello remote" },
    });

    // Watch the API bus for the echoed message — proves round-trip
    const seen: string[] = [];
    apiBus.subscribe("witness", "echo.output");
    const deadline2 = Date.now() + 2500;
    while (Date.now() < deadline2 && seen.length === 0) {
      await wait(50);
      const msgs = apiBus.getUnreadMessages("witness");
      for (const m of msgs) seen.push((m.payload as { content: string }).content);
    }
    expect(seen.length).toBeGreaterThan(0);

    // Now DELETE through the API: the kill request must hit the agent
    api.killNode(stub.id);
    const deadline3 = Date.now() + 2000;
    while (Date.now() < deadline3 && agent.instanceRegistry.get(stub.id)) {
      await wait(50);
    }
    expect(agent.instanceRegistry.get(stub.id)).toBeUndefined();

    // Cleanup
    api.killAll();
    agent.killAll();
    await apiBus.close();
    await agentBus.close();
  });
});
