import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrainService, LLMRegistry } from "@brain/core";
import type { Message } from "@brain/sdk";
import * as path from "path";

describe("Brain node: central consciousness", () => {
  let brain: BrainService;

  beforeAll(async () => {
    LLMRegistry.resetInstance();
    brain = new BrainService(":memory:");
    const nodesDir = path.resolve(__dirname, "../nodes");
    brain.bootstrap(nodesDir);
    await LLMRegistry.getInstance().initialize();
  }, 60000);

  afterAll(() => {
    brain.killAll();
  });

  it("spawns, receives messages, and responds or sleeps", async () => {
    if (!LLMRegistry.getInstance().isAvailable("ollama")) {
      return;
    }

    const collected: Message[] = [];
    brain.bus.on("message:published", (msg: Message) => {
      if (msg.topic === "brain.output") {
        collected.push(msg);
      }
    });

    // Spawn a clock first so the brain has something to see
    await brain.spawnNode({ type: "clock", name: "bg-clock" });

    // Spawn the brain
    const brainNode = await brain.spawnNode({
      type: "brain",
      name: "consciousness",
      subscriptions: [
        { topic: "brain.*" },
        { topic: "alerts.*" },
      ],
      config_overrides: {
        model: "ollama/gemma4:e4b",
        response_topic: "brain.output",
        max_steps: 5,
        idle_sleep: "5s",
      },
    });

    expect(brainNode.state).toBe("active");
    expect(brainNode.authority_level).toBe(2); // root

    // Wait for the brain to run at least one iteration
    await new Promise((r) => { setTimeout(r, 3000); });

    // Send it a message
    brain.bus.publish({
      from: "test",
      topic: "brain.request",
      type: "text",
      criticality: 5,
      payload: { content: "What nodes are currently running? Just list their names." },
    });

    // Wait for response
    const maxWait = 60000;
    const start = Date.now();
    while (collected.length === 0 && Date.now() - start < maxWait) {
      await new Promise((r) => { setTimeout(r, 1000); });
    }

    // The brain should have responded or gone to sleep (both are valid)
    const brainState = brain.instanceRegistry.get(brainNode.id);
    expect(brainState).toBeDefined();

    // It either published a response or is sleeping (both valid for a small model)
    const responded = collected.length > 0;
    const sleeping = brainState?.state === "sleeping";

    expect(responded || sleeping).toBe(true);

    if (responded) {
      const payload = collected[0].payload as Record<string, unknown>;
      expect(typeof payload.content === "string" || typeof payload.title === "string").toBe(true);
    }

    brain.killAll();
  }, 90000);

  it("can be asked to sleep and wakes on message", async () => {
    if (!LLMRegistry.getInstance().isAvailable("ollama")) {
      return;
    }

    const brainNode = await brain.spawnNode({
      type: "brain",
      name: "sleep-test-brain",
      subscriptions: [{ topic: "brain.wake-test" }],
      config_overrides: {
        model: "ollama/gemma4:e4b",
        idle_sleep: "2s",
        max_steps: 3,
      },
    });

    // Let it run one idle iteration and go to sleep
    await new Promise((r) => { setTimeout(r, 15000); });

    const state = brain.instanceRegistry.get(brainNode.id);
    // Should be sleeping (idle with no messages)
    expect(state?.state).toBe("sleeping");

    // Send a message to wake it
    brain.bus.publish({
      from: "test",
      topic: "brain.wake-test",
      type: "text",
      criticality: 3,
      payload: { content: "Wake up!" },
    });

    // Give it time to wake and process
    await new Promise((r) => { setTimeout(r, 5000); });

    const stateAfter = brain.instanceRegistry.get(brainNode.id);
    // Should be active or sleeping again (processed the message then went back to sleep)
    expect(stateAfter?.state === "active" || stateAfter?.state === "sleeping").toBe(true);

    brain.killAll();
  }, 60000);
});
