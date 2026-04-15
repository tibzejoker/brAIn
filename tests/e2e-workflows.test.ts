/**
 * End-to-end workflow tests.
 *
 * Each test boots a fresh network (new BrainService, empty bus, clean memory),
 * runs a scenario, and validates the result. Retries up to 2 times per test
 * with a full reset between each attempt.
 *
 * Requires: Ollama running with the test model.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { BrainService, LLMRegistry } from "@brain/core";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";

const TEST_MODEL = "ollama/gemma4:e4b";
const TIMEOUT_PER_ATTEMPT = 90_000;
const MAX_ATTEMPTS = 2;
const NODES_DIR = path.resolve(__dirname, "..", "nodes");
const DATA_DIR = path.resolve(__dirname, "..", "data");
const MEM_PATH = path.join(DATA_DIR, "memory.json");

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return false;
    const data = await res.json() as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.includes("gemma4"));
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}

async function waitForMessage(
  brain: BrainService,
  topic: string,
  needle: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(3000);
    const msgs = brain.bus.getMessageHistory({ topic, last: 20 });
    for (const msg of msgs) {
      const content = (msg.payload as { content?: string }).content ?? "";
      if (content.toLowerCase().includes(needle.toLowerCase())) return content;
    }
  }
  return null;
}

function sendChat(brain: BrainService, content: string): void {
  brain.bus.publish({
    from: "e2e-test", topic: "chat.input", type: "text", criticality: 5,
    payload: { content },
  });
}

function debugDump(brain: BrainService): void {
  const brainNode = brain.getNetworkSnapshot({ state: "all" }).find((n) => n.type === "brain");
  const logs = brainNode ? brain.getNodeLogs(brainNode.id, 15) : [];
  const msgs = brain.bus.getMessageHistory({ last: 8 });
  console.log("  Brain logs:");
  for (const l of logs) console.log(`    [${l.level}] ${l.message.slice(0, 120)}`);
  console.log("  Bus:");
  for (const m of msgs) console.log(`    ${m.topic}: ${(m.payload as { content?: string }).content?.slice(0, 80)}`);
}

// === Full reset: new BrainService, empty bus, clean memory ===

function resetMemory(seed?: Record<string, unknown>): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEM_PATH, JSON.stringify(seed ?? {}, null, 2));
}

async function freshNetwork(extraNodes: string[] = []): Promise<BrainService> {
  const brain = new BrainService(":memory:");
  brain.bootstrap(NODES_DIR);
  await LLMRegistry.getInstance().initialize();

  await brain.spawnNode({ type: "memory", name: "memory" });
  await brain.spawnNode({
    type: "memory-proxy", name: "memory-proxy",
    config_overrides: { model: TEST_MODEL, response_topic: "mem.response" },
  });
  await brain.spawnNode({
    type: "brain", name: "consciousness",
    subscriptions: [
      { topic: "chat.input" }, { topic: "alerts.*" },
      { topic: "mem.response" }, { topic: "memory.result" },
      { topic: "cmd.output" }, { topic: "http.response" },
    ],
    config_overrides: {
      model: TEST_MODEL, response_topic: "chat.response",
      max_steps: 10, max_iterations: 8, handler_timeout_ms: 120000,
    },
  });

  for (const type of extraNodes) {
    if (type === "terminal") {
      await brain.spawnNode({
        type: "terminal", name: "shell",
        subscriptions: [{ topic: "cmd.exec" }],
        config_overrides: {
          response_topic: "cmd.output", timeout_ms: 10000,
          allowed_commands: ["echo", "date", "whoami", "ls", "cat", "head"],
        },
      });
    }
  }

  await delay(3000);
  return brain;
}

// === Retry helper: full reset between each attempt ===

async function withRetry(
  opts: {
    setup: () => Promise<BrainService>;
    run: (brain: BrainService) => Promise<boolean>;
    label: string;
  },
): Promise<{ success: boolean; brain: BrainService }> {
  let brain: BrainService | null = null;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // Full cleanup of previous attempt
    if (brain) { brain.killAll(); brain = null; }

    brain = await opts.setup();
    const ok = await opts.run(brain);

    if (ok) return { success: true, brain };

    console.log(`\n  ${opts.label} attempt ${i + 1}/${MAX_ATTEMPTS} FAILED`);
    debugDump(brain);
  }

  return { success: false, brain: brain as BrainService };
}

describe("e2e workflows", async () => {
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    it.skip("Ollama not available — skipping e2e workflows", () => {});
    return;
  }

  // Backup original memory once
  const hadMemory = fs.existsSync(MEM_PATH);
  const memBackupPath = `${MEM_PATH}.e2e-workflows-bak`;
  beforeAll(() => { if (hadMemory) fs.copyFileSync(MEM_PATH, memBackupPath); });

  let lastBrain: BrainService | null = null;
  afterEach(() => { try { lastBrain?.killAll(); } catch { /* */ } lastBrain = null; });
  afterAll(() => {
    if (hadMemory && fs.existsSync(memBackupPath)) {
      fs.copyFileSync(memBackupPath, MEM_PATH);
      fs.unlinkSync(memBackupPath);
    } else if (fs.existsSync(MEM_PATH)) {
      fs.unlinkSync(MEM_PATH);
    }
  });

  // ========================================================
  // TEST 1: Shell command — echo a random token
  // ========================================================
  it("executes a shell command and returns the result", async () => {
    const token = crypto.randomBytes(6).toString("hex");

    const { success, brain } = await withRetry({
      label: "Shell",
      setup: async () => { resetMemory(); return freshNetwork(["terminal"]); },
      run: async (b) => {
        sendChat(b, [
          `Run this shell command: echo "${token}"`,
          `Use publish_message with topic "cmd.exec" and content: echo "${token}"`,
          `Then tell me the output.`,
        ].join(" "));
        return (await waitForMessage(b, "chat.response", token, TIMEOUT_PER_ATTEMPT)) !== null;
      },
    });
    lastBrain = brain;

    expect(success, `Token "${token}" not found in chat.response`).toBe(true);
  }, (TIMEOUT_PER_ATTEMPT + 10_000) * MAX_ATTEMPTS);

  // ========================================================
  // TEST 2: Store a fact via brain → mem.store → memory
  // ========================================================
  it("stores a fact in memory via the network", async () => {
    const animal = `ANIMAL-${crypto.randomBytes(4).toString("hex")}`;

    const { success, brain } = await withRetry({
      label: "Store",
      setup: async () => { resetMemory(); return freshNetwork(); },
      run: async (b) => {
        sendChat(b, [
          `Store something in memory for me.`,
          `Use publish_message on topic "mem.store" with this exact JSON as content:`,
          `{"key":"secret_animal","value":"${animal}","tags":["test"]}`,
          `Then confirm.`,
        ].join(" "));

        const storeOk = await waitForMessage(b, "mem.response", "Stored", TIMEOUT_PER_ATTEMPT);
        if (!storeOk) return false;

        const mem = fs.existsSync(MEM_PATH) ? fs.readFileSync(MEM_PATH, "utf-8") : "";
        return mem.includes(animal);
      },
    });
    lastBrain = brain;

    expect(success, `Animal "${animal}" not stored in memory.json`).toBe(true);
  }, (TIMEOUT_PER_ATTEMPT + 10_000) * MAX_ATTEMPTS);

  // ========================================================
  // TEST 3: whoami — brain delegates to terminal
  // ========================================================
  it("runs whoami and returns the correct username", async () => {
    const username = os.userInfo().username;

    const { success, brain } = await withRetry({
      label: "Whoami",
      setup: async () => { resetMemory(); return freshNetwork(["terminal"]); },
      run: async (b) => {
        sendChat(b, [
          `Run the "whoami" command using publish_message on topic "cmd.exec".`,
          `Tell me the result.`,
        ].join(" "));
        return (await waitForMessage(b, "chat.response", username, TIMEOUT_PER_ATTEMPT)) !== null;
      },
    });
    lastBrain = brain;

    expect(success, `Username "${username}" not found in chat.response`).toBe(true);
  }, (TIMEOUT_PER_ATTEMPT + 10_000) * MAX_ATTEMPTS);
});
