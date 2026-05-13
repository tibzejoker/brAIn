/**
 * End-to-end: human chats with the brain, brain delegates to hangman.
 *
 * Real flow exercised:
 *   1. Three nodes spawn: chat (human surface) + brain (consciousness)
 *      + hangman (game service).
 *   2. A `chat.input` message lands as if typed by the user.
 *   3. The brain picks it up, walks `ctx.tools.list()`, calls
 *      `ctx.llm.tool({tool: dispatch, ...})` against Ollama, and the
 *      LLM emits a structured `{kind:"publish", tool_name:
 *      "game.hangman.command", args:{action:"start", ...}}`.
 *   4. The brain publishes on `game.hangman.command` with valid args
 *      (validation-on-publish passes, no rebound `.error`).
 *   5. Hangman flips its state to `playing` and narrates on
 *      `game.hangman.event`.
 *
 * This is the canonical regression test for the "brain emits free-text
 * instead of structured command" bug — and for the `schema is not a
 * function` regression in `ctx.llm.tool` when given a plain JSON Schema.
 *
 * Skipped automatically when Ollama isn't reachable locally — the LLM
 * call is non-mockable here on purpose (we want to catch facade-level
 * regressions in the ai-sdk integration).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrainService, LLMRegistry } from "@brain/core";
import type { Message } from "@brain/sdk";
import { allStoreprojectNodeDirs } from "./_helpers/storeprojects-dirs";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

async function ollamaReachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

describe("e2e: human asks brain to launch hangman", () => {
  let brain: BrainService | undefined;
  let hasOllama = false;

  beforeAll(async () => {
    hasOllama = await ollamaReachable();
    if (!hasOllama) return;
    LLMRegistry.resetInstance();
    brain = new BrainService(":memory:");
    brain.bootstrap(allStoreprojectNodeDirs());
    await LLMRegistry.getInstance().initialize();
  }, 60_000);

  afterAll(() => {
    if (brain) brain.killAll();
  });

  it(
    "brain delegates 'launch hangman' to the hangman service via a structured tool call",
    async () => {
      // `it.runIf` reads its arg at file-collection time, BEFORE beforeAll
      // gets to probe Ollama. So we gate inside the test instead — if
      // Ollama isn't reachable, soft-skip with a console hint and return.
      if (!hasOllama && process.env.FORCE_E2E !== "1") {
        console.log(`[skipping] Ollama unreachable at ${OLLAMA_URL} (set FORCE_E2E=1 to override)`);
        return;
      }
      if (!brain) throw new Error("brain wasn't initialised — beforeAll bailed");

      // Capture every bus event so we can assert on the exact trail.
      const seen: Message[] = [];
      type BusEmitter = { on(evt: string, cb: (m: Message) => void): void; off(evt: string, cb: (m: Message) => void): void };
      const tap = (m: Message): void => { seen.push(m); };
      (brain.bus as unknown as BusEmitter).on("message:published", tap);

      // Spawn the three nodes the real network uses.
      const chat = await brain.spawnNode({ type: "chat", name: "human" });
      // In production the brain receives `chat.input` because the user
      // wires it instance-side (saved on disk between restarts). For
      // this test we add it explicitly at spawn — `internal:true` is
      // the right fit since the brain doesn't expose chat.input as a
      // callable command, it just listens to whatever the human types.
      const brainNode = await brain.spawnNode({
        type: "brain", name: "consciousness",
        subscriptions: [
          { topic: "brain.*", description: "self", internal: true },
          { topic: "alerts.*", description: "alerts", internal: true },
          { topic: "chat.input", description: "human chat", internal: true },
        ],
        config_overrides: { model: "ollama/gemma4:e4b", max_steps: 4 },
      });
      const hangman = await brain.spawnNode({ type: "hangman", name: "hangman-1" });

      // Let the runners actually start.
      await new Promise((r) => setTimeout(r, 250));

      // Simulate the human typing in the web chat — same shape the
      // chat UI publishes from. `from` is the chat node id, NOT a
      // `system.*` prefix (the brain filters those out).
      brain.bus.publish({
        from: chat.id,
        topic: "chat.input",
        type: "text",
        criticality: 3,
        payload: { content: "tu peux lancer un pendu stp ?" },
      });

      // Wait — generously — for the brain to make ONE successful
      // tool call that publishes on `game.hangman.command` with a
      // valid `{action:"start"}` payload. Single Ollama call can take
      // 5–30s; we poll up to 90s.
      const startedAt = Date.now();
      const deadline = startedAt + 90_000;
      let cmdMessage: Message | undefined;

      while (Date.now() < deadline) {
        cmdMessage = seen.find((m) => {
          if (m.topic !== "game.hangman.command") return false;
          if (m.from !== brainNode.id) return false;
          try {
            const args = JSON.parse((m.payload as { content: string }).content) as { action?: string };
            return args.action === "start";
          } catch { return false; }
        });
        if (cmdMessage) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      (brain.bus as unknown as BusEmitter).off("message:published", tap);

      // === assertions ===
      // (1) The brain made it through to publish a valid command.
      // If no VALID command landed, dump every game.hangman.command the
      // brain produced so we can see whether the bug is "no publish at
      // all" vs "publish with wrong args shape".
      const allHangmanCmds = seen
        .filter((m) => m.topic === "game.hangman.command" && m.from === brainNode.id)
        .map((m) => (m.payload as { content: string }).content);
      const lastErrors = seen
        .filter((m) => m.topic === "llm.usage")
        .slice(-5)
        .map((m) => {
          try { return JSON.parse((m.payload as { content: string }).content) as { error?: string }; }
          catch { return {}; }
        })
        .map((u) => u.error)
        .filter(Boolean);
      expect(cmdMessage,
        `brain didn't publish a valid game.hangman.command within 90s.\n` +
        `Saw ${seen.length} bus events total.\n` +
        `Brain's hangman.command publishes (${allHangmanCmds.length}): ${JSON.stringify(allHangmanCmds, null, 2)}\n` +
        `Last LLM errors: ${JSON.stringify(lastErrors)}`
      ).toBeDefined();

      // (2) NO validator-rebound error event for the brain's publish
      // — i.e. the args matched hangman's declared inputSchema.
      const validationErrors = seen.filter((m) =>
        m.topic === "game.hangman.command.error" &&
        m.from === "system.bus.validator",
      );
      expect(
        validationErrors,
        `validation-on-publish rejected the brain's args. Errors: ${JSON.stringify(
          validationErrors.map((m) => {
            try {
              const body = JSON.parse((m.payload as { content: string }).content) as unknown;
              return body;
            } catch { return (m.payload as { content: string }).content; }
          }),
          null, 2,
        )}\nBrain's hangman.command publishes: ${JSON.stringify(allHangmanCmds, null, 2)}`,
      ).toHaveLength(0);

      // (3) The brain's llm.usage events show it routed via the new
      // multi-tool path (NOT the legacy `text` parsing path nor the
      // old single-`tool` + oneOf antipattern).
      const toolUsageEvents = seen
        .filter((m) => m.topic === "llm.usage" && m.from === brainNode.id)
        .map((m) => {
          try { return JSON.parse((m.payload as { content: string }).content) as { call_kind?: string; error?: string }; }
          catch { return {} as { call_kind?: string }; }
        });
      expect(toolUsageEvents.some((u) => u.call_kind === "tools" && !u.error)).toBe(true);

      // (4) Hangman acknowledged — at least one state or event message
      // came back from the hangman node after our command landed.
      const cmdTs = cmdMessage!.timestamp;
      const hangmanReplied = seen.some((m) =>
        m.from === hangman.id &&
        m.timestamp >= cmdTs &&
        (m.topic === "game.hangman.state" || m.topic === "game.hangman.event"),
      );
      expect(hangmanReplied, "hangman never reacted to the brain's command").toBe(true);
    },
    120_000,
  );
});
