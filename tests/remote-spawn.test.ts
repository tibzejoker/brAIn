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

  it("API stop/start/wake commands route over NATS to the agent runner", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "remote-control-"));
    const nodesDir = resolve(__dirname, "..", "nodes");

    const apiBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "rc" });
    const agentBus = new NatsBusService({ url: `nats://127.0.0.1:${PORT}`, prefix: "rc" });
    await apiBus.connect();
    await agentBus.connect();

    const api = new BrainService(join(scratch, "api.db"), apiBus);
    api.bootstrap(nodesDir);
    const agent = new BrainService(join(scratch, "agent.db"), agentBus);
    agent.bootstrap(nodesDir);

    const controlNodeId = "agent:agent-B:control";
    for (const action of ["spawn", "kill", "stop", "start", "wake"]) {
      agentBus.subscribe(controlNodeId, `brain.agents.agent-B.${action}`);
    }
    agentBus.on(`message:${controlNodeId}`, (msg) => {
      void (async (): Promise<void> => {
        const data = JSON.parse((msg.payload as { content: string }).content);
        const action = msg.topic.split(".").pop() ?? "";
        const nodeId = (data.node_id as string | undefined) ?? (data.id as string | undefined);
        if (action === "spawn") {
          const cfg = { ...data.config, id: data.id, transport: "process" as const };
          await agent.spawnNode(cfg);
          return;
        }
        if (!nodeId) return;
        switch (action) {
          case "stop": agent.stopNode(nodeId); break;
          case "start": await agent.startNode(nodeId); break;
          case "wake": agent.wakeNode(nodeId); break;
          case "kill": agent.killNode(nodeId); break;
        }
      })();
    });

    const stub = await api.spawnNode({
      type: "echo",
      name: "echo-controlled",
      transport: "remote",
      target_agent_id: "agent-B",
      subscriptions: [{ topic: "ctl.test.in" }],
    });

    // Wait for the agent to spawn the runner
    const t0 = Date.now() + 2000;
    while (Date.now() < t0 && !agent.instanceRegistry.get(stub.id)) await wait(50);
    expect(agent.instanceRegistry.get(stub.id)).toBeDefined();

    // 1) stop → agent's local state goes STOPPED
    expect(api.stopNode(stub.id)).toBe(true);
    const t1 = Date.now() + 1500;
    while (Date.now() < t1 && agent.instanceRegistry.get(stub.id)?.state !== "stopped") await wait(50);
    expect(agent.instanceRegistry.get(stub.id)?.state).toBe("stopped");
    // API mirrors the state optimistically
    expect(api.instanceRegistry.get(stub.id)?.state).toBe("stopped");

    // 2) start → agent comes back ACTIVE
    expect(await api.startNode(stub.id)).toBe(true);
    const t2 = Date.now() + 1500;
    while (Date.now() < t2 && agent.instanceRegistry.get(stub.id)?.state !== "active") await wait(50);
    expect(agent.instanceRegistry.get(stub.id)?.state).toBe("active");

    // 3) kill cleans up both sides
    api.killNode(stub.id);
    const t3 = Date.now() + 1500;
    while (Date.now() < t3 && agent.instanceRegistry.get(stub.id)) await wait(50);
    expect(agent.instanceRegistry.get(stub.id)).toBeUndefined();
    expect(api.instanceRegistry.get(stub.id)).toBeUndefined();

    api.killAll();
    agent.killAll();
    await apiBus.close();
    await agentBus.close();
  });
});
