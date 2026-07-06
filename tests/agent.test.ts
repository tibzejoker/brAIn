/**
 * Agent integration tests — boots a real `nats-server`, an `Agent`,
 * and an `AgentDirectory` on the API side; verifies announcements
 * flow and a message published on one side reaches a node on the
 * other.
 *
 * Skipped when `nats-server` isn't on PATH.
 */
import { describe, it, expect } from "vitest";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentDirectory } from "../packages/agent/src/agent";
import { BrainService, NatsBusService, startAgentPresence } from "@brain/core";
import type { Message } from "@brain/sdk";
import { resolve } from "node:path";
import { allStoreprojectNodeDirs } from "./_helpers/storeprojects-dirs";

// Shared broker from tests/_setup/nats-broker.ts.
const URL = process.env.BRAIN_TEST_NATS_URL;
const HAS_NATS = !!URL;

describe.skipIf(!HAS_NATS)("brAIn-agent + AgentDirectory", () => {
  it("an agent's announcement is received by the API directory", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-test-"));
    const apiBus = new NatsBusService({ url: URL!, prefix: "agt1" });
    await apiBus.connect();
    const dir = new AgentDirectory(apiBus, { ttlMs: 5000 });
    dir.attach();

    const agent = new Agent({
      agentId: "test-agent-1",
      host: "test-host",
      natsUrl: URL!,
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
    const agentBus = new NatsBusService({ url: URL!, prefix: "agt1" });
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
    const apiBus = new NatsBusService({ url: URL!, prefix: "agt2" });
    const agentBus = new NatsBusService({ url: URL!, prefix: "agt2" });
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

  it("API drops a remote node's local stub when its agent stops announcing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-expire-"));
    const apiBus = new NatsBusService({ url: URL!, prefix: "agt3" });
    await apiBus.connect();
    // Aggressive TTL so the test runs in a couple of seconds.
    const api = new BrainService(
      join(scratch, "api.db"),
      apiBus,
      { agentDirectory: { ttlMs: 600, sweepIntervalMs: 100 } },
    );
    api.bootstrap(resolve(__dirname, "..", "nodes"));

    // Inject one announcement so the agent is "alive" briefly.
    apiBus.publish({
      from: "agent:dying-agent", topic: "brain.agents.discover",
      type: "text", criticality: 0,
      payload: { content: JSON.stringify({
        agent_id: "dying-agent", host: "ghost", pid: 1,
        started_at: Date.now(), types: ["echo"], ts: Date.now(),
      }) },
    });
    await wait(150);
    expect(api.agents.has("dying-agent")).toBe(true);

    // Spawn a remote node addressed to that agent. No real agent
    // process is running — we only test the API's stub bookkeeping.
    const stub = await api.spawnNode({
      type: "echo", name: "zombie-echo",
      transport: "remote", target_agent_id: "dying-agent",
    });
    expect(api.instanceRegistry.get(stub.id)).toBeDefined();

    // Wait past the TTL — the sweep should fire, the agent is dropped
    // and dropExpiredAgentNodes cleans up the orphaned stub.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && api.instanceRegistry.get(stub.id)) await wait(50);
    expect(api.instanceRegistry.get(stub.id)).toBeUndefined();
    expect(api.agents.has("dying-agent")).toBe(false);

    api.agents.detach();
    api.killAll();
    await apiBus.close();
  });

  it("node_call from the owning hub wakes a node hosted by a remote agent", async () => {
    const hubBus = new NatsBusService({ url: URL!, prefix: "agt4" });
    const agentBus = new NatsBusService({ url: URL!, prefix: "agt4" });
    await hubBus.connect(); await agentBus.connect();
    const hub = new BrainService(":memory:", hubBus);
    hub.bootstrap(allStoreprojectNodeDirs());
    const agent = new BrainService(":memory:", agentBus);
    agent.bootstrap(allStoreprojectNodeDirs());
    const hubPresence = startAgentPresence({ brain: hub, bus: hubBus, agentId: "hub-A", host: "hub" });
    const agentPresence = startAgentPresence({ brain: agent, bus: agentBus, agentId: "agent-B", host: "pc" });
    try {
      // Spawn THROUGH the hub: stub locally, real runner on the agent.
      const stub = await hub.spawnNode({
        type: "echo", name: "echo-far",
        transport: "remote", target_agent_id: "agent-B",
        subscriptions: [{ topic: "far.ping" }],
      });
      let hosted = agent.instanceRegistry.get(stub.id);
      const spawnDeadline = Date.now() + 3000;
      while (Date.now() < spawnDeadline && !hosted) {
        await wait(50);
        hosted = agent.instanceRegistry.get(stub.id);
      }
      expect(hosted).toBeDefined();

      // Drive it exactly like POST /node/:id/far.ping — node_call answered
      // by the OWNING hub, which has only the registry stub (no live bus
      // subscriptions for the node).
      const reply = await hubBus.requestRemote<{ message_id: string }>(
        "brain.agents.hub-A.node_call",
        { nodeId: stub.id, topic: "far.ping", body: { content: "ping-across" } },
      );
      expect(reply.message_id).toBeTruthy();

      // The echo handler on the agent republishes on echo.output. Regression:
      // node_call used `from: <node id>` when the local bus had no subs, and
      // the hosting agent's anti-loop swallowed the message — no wake, ever.
      const deadline = Date.now() + 5000;
      let out: Message[] = [];
      while (Date.now() < deadline && out.length === 0) {
        await wait(100);
        out = hubBus.getMessageHistory({ topic: "echo.output", last: 5 })
          .filter((m) => m.from === stub.id);
      }
      expect(out.length).toBeGreaterThan(0);
      expect((out[0].payload as { content: string }).content).toContain("ping-across");
    } finally {
      hubPresence.stop(); agentPresence.stop();
      hub.killAll(); agent.killAll();
      await hubBus.close(); await agentBus.close();
    }
  }, 30000);
});
