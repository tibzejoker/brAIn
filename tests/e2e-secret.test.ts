/**
 * End-to-end test: retrieve a secret from memory via the full network.
 *
 * Flow: chat.input → brain → mem.ask → memory-proxy → memory KV → brain → chat.response
 *
 * Seeds a random hex code into the memory store (un-guessable), then asks
 * the brain to retrieve it. Full reset between retry attempts.
 *
 * Requires: Ollama running with the test model.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { BrainService, LLMRegistry } from "@brain/core";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const TEST_MODEL = "ollama/gemma4:e4b";
const TIMEOUT_PER_ATTEMPT = 60_000;
const MAX_ATTEMPTS = 3;
const SECRET = `CODE-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
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

describe("e2e: secret retrieval through full network", async () => {
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    it.skip("Ollama not available — skipping e2e", () => {});
    return;
  }

  // Backup memory once
  const hadMemory = fs.existsSync(MEM_PATH);
  const backupPath = `${MEM_PATH}.e2e-secret-bak`;
  beforeAll(() => { if (hadMemory) fs.copyFileSync(MEM_PATH, backupPath); });
  afterAll(() => {
    if (hadMemory && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, MEM_PATH);
      fs.unlinkSync(backupPath);
    } else if (fs.existsSync(MEM_PATH)) {
      fs.unlinkSync(MEM_PATH);
    }
  });

  let brain: BrainService | null = null;
  afterEach(() => { try { brain?.killAll(); } catch { /* */ } brain = null; });

  /** Full reset: seed memory + boot fresh network. */
  async function freshSetup(): Promise<BrainService> {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEM_PATH, JSON.stringify({
      e2e_secret_code: {
        key: "e2e_secret_code",
        value: SECRET,
        tags: ["e2e", "secret"],
        created_at: Date.now(),
        updated_at: Date.now(),
        created_by: "e2e-test",
      },
    }, null, 2));

    const b = new BrainService(":memory:");
    b.bootstrap(NODES_DIR);
    await LLMRegistry.getInstance().initialize();

    await b.spawnNode({ type: "memory", name: "memory" });
    await b.spawnNode({
      type: "memory-proxy", name: "memory-proxy",
      config_overrides: { model: TEST_MODEL, response_topic: "mem.response" },
    });
    await b.spawnNode({
      type: "brain", name: "consciousness",
      subscriptions: [
        { topic: "chat.input" }, { topic: "alerts.*" },
        { topic: "mem.response" }, { topic: "memory.result" },
      ],
      config_overrides: {
        model: TEST_MODEL, response_topic: "chat.response",
        max_steps: 10, max_iterations: 8, handler_timeout_ms: 120000,
      },
    });

    await delay(3000);
    return b;
  }

  it(`retrieves secret "${SECRET.slice(0, 20)}..." from memory`, async () => {
    let found = false;
    let lastResponse = "";

    for (let i = 0; i < MAX_ATTEMPTS && !found; i++) {
      // Full reset — new BrainService, clean bus, fresh memory seed
      if (brain) { brain.killAll(); brain = null; }
      brain = await freshSetup();

      brain.bus.publish({
        from: "e2e-test", topic: "chat.input", type: "text", criticality: 5,
        payload: {
          content: [
            'Search your memory for the key "e2e_secret_code" using publish_message on topic "mem.ask".',
            "Tell me the exact value you find. Do NOT guess — use the tool.",
          ].join(" "),
        },
      });

      const deadline = Date.now() + TIMEOUT_PER_ATTEMPT;
      while (Date.now() < deadline) {
        await delay(3000);
        const msgs = brain.bus.getMessageHistory({ topic: "chat.response", last: 20 });
        for (const msg of msgs) {
          const content = (msg.payload as { content?: string }).content ?? "";
          if (content.includes(SECRET)) { found = true; break; }
          if (content.length > 0) lastResponse = content;
        }
        if (found) break;
      }

      if (!found) {
        const brainNode = brain.getNetworkSnapshot({ state: "all" }).find((n) => n.type === "brain");
        const logs = brainNode ? brain.getNodeLogs(brainNode.id, 20) : [];
        const msgs = brain.bus.getMessageHistory({ last: 10 });
        console.log(`\n  Attempt ${i + 1}/${MAX_ATTEMPTS} FAILED`);
        console.log("  Last response:", lastResponse.slice(0, 200));
        console.log("  Brain logs:");
        for (const l of logs) console.log(`    [${l.level}] ${l.message.slice(0, 120)}`);
        console.log("  Bus:");
        for (const m of msgs) console.log(`    ${m.topic}: ${(m.payload as { content?: string }).content?.slice(0, 80)}`);
      }
    }

    expect(found, `Secret "${SECRET}" not found. Last: "${lastResponse.slice(0, 200)}"`).toBe(true);
  }, (TIMEOUT_PER_ATTEMPT + 10_000) * MAX_ATTEMPTS);
});
