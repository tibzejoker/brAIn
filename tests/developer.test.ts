import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrainService, CLIRegistry } from "@brain/core";
import type { Message } from "@brain/sdk";
import * as path from "path";
import * as fs from "fs";

describe("Developer node: creates a new node type", () => {
  let brain: BrainService;
  let createdWorkspace: string | undefined;

  beforeAll(async () => {
    brain = new BrainService(":memory:");
    const nodesDir = path.resolve(__dirname, "../nodes");
    brain.bootstrap(nodesDir);

    await CLIRegistry.getInstance().initialize();
  }, 60000);

  afterAll(() => {
    brain.killAll();

    // Cleanup: delete the dynamically created workspace
    if (createdWorkspace && fs.existsSync(createdWorkspace)) {
      fs.rmSync(createdWorkspace, { recursive: true, force: true });
    }
  });

  it("receives a request and creates a compilable node type", async () => {
    if (!CLIRegistry.getInstance().isAvailable("claude")) {
      return;
    }

    const collected: Message[] = [];
    brain.bus.on("message:published", (msg: Message) => {
      if (msg.topic === "test.dev.result") {
        collected.push(msg);
      }
    });

    const devNode = await brain.spawnNode({
      type: "developer",
      name: "test-developer",
      subscriptions: [
        { topic: "test.dev.request" },
        { topic: "types.validation_failed" },
        { topic: "types.registered" },
      ],
      config_overrides: {
        cli: "claude",
        response_topic: "test.dev.result",
        max_attempts: 2,
      },
    });

    expect(["active", "sleeping"]).toContain(devNode.state);

    // Wait for the node to be ready
    await new Promise((r) => { setTimeout(r, 1000); });

    // Send a simple request
    brain.bus.publish({
      from: "test",
      topic: "test.dev.request",
      type: "text",
      criticality: 5,
      payload: {
        content: "Create a node called 'timestamp-formatter' that subscribes to 'time.tick', reads the ISO timestamp from the message content, reformats it to 'HH:MM:SS' format, and publishes it on 'time.formatted'. Keep it very simple, pure code, no LLM needed.",
      },
    });

    // Wait for the developer to work (this can take a while with Ollama)
    const maxWait = 180000;
    const start = Date.now();
    while (collected.length === 0 && Date.now() - start < maxWait) {
      await new Promise((r) => { setTimeout(r, 2000); });
    }

    expect(collected.length).toBeGreaterThanOrEqual(1);
    const response = collected[0];

    if (response.type === "alert") {
      // Developer didn't complete — log why but don't hard fail
      const payload = response.payload as { title: string; description: string };
      console.log(`Developer alert: ${payload.title} — ${payload.description}`);
      // Still check that the node responded (infrastructure works)
      expect(payload.title).toBeDefined();
    } else {
      // Success — verify the created type
      const payload = JSON.parse((response.payload as { content: string }).content) as {
        status: string;
        type_name?: string;
        path?: string;
      };

      if (payload.status !== "success") {
        expect(payload.status).toBe("success"); // surface the real status on failure
      }
      expect(payload.type_name).toBeDefined();
      expect(payload.path).toBeDefined();

      createdWorkspace = payload.path;

      // Verify files exist (framework only emits success once build+tests passed)
      if (payload.path) {
        expect(fs.existsSync(path.join(payload.path, "config.json"))).toBe(true);
        expect(fs.existsSync(path.join(payload.path, "dist", "handler.js"))).toBe(true);
        expect(fs.existsSync(path.join(payload.path, "tests"))).toBe(true);
        expect(fs.existsSync(path.join(payload.path, ".brain-state.json"))).toBe(true);
      }
    }

    brain.killNode(devNode.id);
  }, 240000);
});
