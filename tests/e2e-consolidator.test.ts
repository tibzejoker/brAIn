/**
 * E2E: Memory consolidator cleans up contradictory/duplicate entries.
 *
 * Seeds memory with:
 *   - Two contradictory facts (user lives in Paris vs Lyon, different dates)
 *   - Two duplicate entries (same content, different keys)
 *   - One stale test entry
 *
 * Spawns the consolidator and lets it run with its budget.
 * Verifies that the memory is cleaner after consolidation.
 *
 * Requires: Ollama running with the test model.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { BrainService, LLMRegistry } from "@brain/core";
import * as fs from "fs";
import * as path from "path";

const TEST_MODEL = "ollama/gemma4:e4b";
const NODES_DIR = path.resolve(__dirname, "..", "nodes");
const DATA_DIR = path.resolve(__dirname, "..", "data");
const MEM_PATH = path.join(DATA_DIR, "memory.json");
const MAX_WAIT = 90_000;
const MAX_ATTEMPTS = 2;

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

const TWO_DAYS_AGO = Date.now() - 2 * 86_400_000;
const ONE_HOUR_AGO = Date.now() - 3_600_000;
const NOW = Date.now();

function seedMemory(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const data: Record<string, unknown> = {
    // Contradictory: old says Paris, recent says Lyon
    user_city_old: {
      key: "user_city_old",
      value: "The user lives in Paris",
      tags: ["user", "location"],
      created_at: TWO_DAYS_AGO,
      updated_at: TWO_DAYS_AGO,
      created_by: "test",
      created_date: new Date(TWO_DAYS_AGO).toISOString(),
      updated_date: new Date(TWO_DAYS_AGO).toISOString(),
    },
    user_city_new: {
      key: "user_city_new",
      value: "The user moved to Lyon",
      tags: ["user", "location"],
      created_at: NOW,
      updated_at: NOW,
      created_by: "test",
      created_date: new Date(NOW).toISOString(),
      updated_date: new Date(NOW).toISOString(),
    },
    // Duplicates: same info, different keys
    user_job_1: {
      key: "user_job_1",
      value: "Thibaut is a software developer",
      tags: ["user"],
      created_at: ONE_HOUR_AGO,
      updated_at: ONE_HOUR_AGO,
      created_by: "test",
      created_date: new Date(ONE_HOUR_AGO).toISOString(),
      updated_date: new Date(ONE_HOUR_AGO).toISOString(),
    },
    user_job_2: {
      key: "user_job_2",
      value: "Thibaut is a software developer",
      tags: ["user"],
      created_at: NOW,
      updated_at: NOW,
      created_by: "test",
      created_date: new Date(NOW).toISOString(),
      updated_date: new Date(NOW).toISOString(),
    },
    // Stale test data
    test_garbage: {
      key: "test_garbage",
      value: "ANIMAL-abc123 test data from e2e run",
      tags: ["test"],
      created_at: TWO_DAYS_AGO,
      updated_at: TWO_DAYS_AGO,
      created_by: "e2e-test",
      created_date: new Date(TWO_DAYS_AGO).toISOString(),
      updated_date: new Date(TWO_DAYS_AGO).toISOString(),
    },
  };

  fs.writeFileSync(MEM_PATH, JSON.stringify(data, null, 2));
}

function readMemory(): Record<string, { key: string; value: string; tags: string[] }> {
  if (!fs.existsSync(MEM_PATH)) return {};
  return JSON.parse(fs.readFileSync(MEM_PATH, "utf-8")) as Record<string, { key: string; value: string; tags: string[] }>;
}

describe("e2e: memory consolidator", async () => {
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    it.skip("Ollama not available", () => {});
    return;
  }

  const hadMemory = fs.existsSync(MEM_PATH);
  const memBackup = `${MEM_PATH}.consolidator-bak`;

  afterAll(() => {
    if (hadMemory && fs.existsSync(memBackup)) {
      fs.copyFileSync(memBackup, MEM_PATH); fs.unlinkSync(memBackup);
    } else if (fs.existsSync(MEM_PATH)) {
      fs.unlinkSync(MEM_PATH);
    }
  });

  let brain: BrainService | null = null;
  afterEach(() => { try { brain?.killAll(); } catch { /* */ } brain = null; });

  it("consolidates contradictory and duplicate memories", async () => {
    let cleaned = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !cleaned; attempt++) {
      // Full reset
      if (brain) { brain.killAll(); brain = null; }
      if (hadMemory && attempt === 0) fs.copyFileSync(MEM_PATH, memBackup);
      seedMemory();

      const before = readMemory();
      const keysBefore = Object.keys(before);
      console.log(`\n  Attempt ${attempt + 1}: ${keysBefore.length} entries before consolidation`);

      brain = new BrainService(":memory:");
      brain.bootstrap(NODES_DIR);
      await LLMRegistry.getInstance().initialize();

      // Spawn memory KV (needed for the consolidator to talk to)
      await brain.spawnNode({ type: "memory", name: "memory" });

      // Spawn consolidator — it wakes immediately (no sleep state)
      const consolidator = await brain.spawnNode({
        type: "memory-consolidator",
        name: "memory-janitor",
        subscriptions: [{ topic: "memory.result" }],
        config_overrides: {
          model: TEST_MODEL,
          max_iterations: 8,
          forced_sleep: "5s",
        },
      });

      // Send it a kick to start (it needs a message or timer wake)
      await delay(2000);
      brain.bus.publish({
        from: "test", topic: "memory.result", type: "text", criticality: 1,
        payload: { content: "Wake up and start maintenance." },
      });

      // Wait for consolidator to finish its budget and sleep
      const deadline = Date.now() + MAX_WAIT;
      while (Date.now() < deadline) {
        await delay(3000);

        const after = readMemory();
        const keysAfter = Object.keys(after);

        // Track if anything changed
        if (!cleaned) {
          const entriesRemoved = keysAfter.length < keysBefore.length;
          const valuesChanged = keysAfter.some((k) => {
            const bVal = (before[k] as { value?: string } | undefined)?.value;
            const aVal = (after[k] as { value?: string } | undefined)?.value;
            return bVal !== undefined && aVal !== undefined && bVal !== aVal;
          });
          if (entriesRemoved || valuesChanged) cleaned = true;
        }

        // Wait until the consolidator goes to sleep (done with its budget)
        const state = brain.instanceRegistry.get(consolidator.id);
        if (cleaned && state?.state === "sleeping") {
          const afterFinal = readMemory();
          const keysFinal = Object.keys(afterFinal);
          console.log(`  Done: ${keysFinal.length} entries (was ${keysBefore.length})`);
          console.log("  Remaining:", keysFinal);
          break;
        }
      }

      // Dump logs
      const logs = brain.getNodeLogs(consolidator.id, 30);
      console.log("  Consolidator logs:");
      for (const l of logs) console.log(`    [${l.level}] ${l.message.slice(0, 140)}`);
    }

    expect(cleaned, "Consolidator should have modified at least one entry").toBe(true);
  }, (MAX_WAIT + 10_000) * MAX_ATTEMPTS);
});
