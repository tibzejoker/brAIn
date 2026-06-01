/**
 * Skills E2E with a real LLM.
 *
 * Proves the whole procedural-memory pipeline end-to-end, framework-served
 * and working with a SMALL local model (gemma4:e4b):
 *
 *   1. The framework skills responder answers search / load over NATS
 *      request/reply (the exact path `ctx.skills.search/load` takes, so it
 *      works identically for a remote brain-agent node).
 *   2. A small model OBEYS an injected skill: we load a skill whose body
 *      says "end with <<DONE>>", feed it as the system prompt to gemma4:e4b,
 *      and the reply carries the marker. No tool-calling required from the
 *      model — the handler retrieves + injects, which is what makes skills
 *      reliable on weak models.
 *
 * Skipped unless RUN_LLM_E2E=1 (and gated on the model being pulled).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrainService, NatsBusService, LLMRegistry, generateText,
  SKILLS_SEARCH_SUBJECT, SKILLS_LOAD_SUBJECT, SKILLS_SAVE_SUBJECT, SKILLS_DELETE_SUBJECT, SKILLS_LIST_SUBJECT,
  type SkillMeta, type SkillFull,
} from "@brain/core";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const TEST_MODEL = "gemma4:e4b";
const NATS_URL = process.env.BRAIN_TEST_NATS_URL;

async function ollamaHasModel(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const data = (await r.json()) as { models?: Array<{ name: string }> };
    return Boolean(data.models?.some((m) => m.name.startsWith(TEST_MODEL)));
  } catch { return false; }
}

let MODEL_AVAILABLE = false;
beforeAll(async () => { MODEL_AVAILABLE = await ollamaHasModel(); }, 5000);

describe.skipIf(!process.env.RUN_LLM_E2E)("Skills — framework-served + small model", () => {
  let brain: BrainService;
  let bus: NatsBusService;
  let scratch: string;

  beforeAll(async () => {
    if (!NATS_URL) return;
    scratch = mkdtempSync(join(tmpdir(), "skills-e2e-"));
    // A deterministic test skill whose body steers the model's output.
    const dir = join(scratch, "skills", "end-marker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), [
      "---",
      "name: end-marker",
      "description: Always finish replies with a marker token. Use for any reply.",
      "---",
      "",
      "# Reply marker",
      "",
      "When you reply, end your message with the exact token: <<DONE>>",
      "",
    ].join("\n"), "utf-8");

    bus = new NatsBusService({ url: NATS_URL, prefix: "skl" });
    await bus.connect();
    brain = new BrainService(join(scratch, "api.db"), bus);
    brain.setSkillsDir(join(scratch, "skills")); // registers the responder
    brain.setPersonalSkillsDir(join(scratch, "personal")); // writable namespace for distillation
    await LLMRegistry.getInstance().initialize();
  }, 30_000);

  afterAll(async () => {
    if (brain) brain.killAll();
    if (bus) await bus.close();
  });

  it("serves search + load over NATS request/reply (the ctx.skills path)", async () => {
    if (!NATS_URL) return;
    const matches = await bus.requestRemote<SkillMeta[]>(SKILLS_SEARCH_SUBJECT, { query: "reply marker token" }, 4000);
    expect(matches.map((m) => m.name)).toContain("end-marker");

    const skill = await bus.requestRemote<SkillFull | null>(SKILLS_LOAD_SUBJECT, { name: "end-marker" }, 4000);
    expect(skill).not.toBeNull();
    expect(skill?.content).toContain("<<DONE>>");
    expect(skill?.version).toMatch(/^[0-9a-f]{12}$/);

    // The catalog (tier-1, Claude/Hermes-style) lists every skill, no query.
    const catalog = await bus.requestRemote<SkillMeta[]>(SKILLS_LIST_SUBJECT, {}, 4000);
    expect(catalog.map((m) => m.name)).toContain("end-marker");
  }, 15_000);

  it("a small model (gemma4:e4b) obeys the injected skill", async () => {
    if (!NATS_URL || !MODEL_AVAILABLE) return;
    const skill = await bus.requestRemote<SkillFull | null>(SKILLS_LOAD_SUBJECT, { name: "end-marker" }, 4000);
    const model = LLMRegistry.getInstance().getModel(`ollama/${TEST_MODEL}`);
    const res = await generateText({
      model,
      system: skill?.content ?? "",
      messages: [{ role: "user", content: "Say hello in one short sentence." }],
      maxOutputTokens: 200,
    });
    // The injected skill steered the small model to append the marker.
    expect(res.text.toLowerCase()).toContain("done");
  }, 60_000);

  it("distils a skill via the LLM, saves it on the bus, and finds it network-wide", async () => {
    if (!NATS_URL || !MODEL_AVAILABLE) return;
    // The node controls the structure (frontmatter); the small model only
    // fills the procedural body — the robust distillation pattern.
    const model = LLMRegistry.getInstance().getModel(`ollama/${TEST_MODEL}`);
    const res = await generateText({
      model,
      system: "Write 2 to 4 short numbered steps. Output ONLY the steps, no preamble.",
      messages: [{ role: "user", content: "Procedure I just did: resized every image in a folder to 800px using `sips -Z 800`." }],
      maxOutputTokens: 200,
    });
    const content = `---\nname: resize-images\ndescription: Resize the images in a folder to a target width.\n---\n\n# Resize images\n\n${res.text.trim()}\n`;

    const saved = await bus.requestRemote<SkillFull & { error?: string }>(SKILLS_SAVE_SUBJECT, { name: "resize-images", content }, 4000);
    expect(saved.error).toBeUndefined();
    expect(saved.name).toBe("resize-images");

    // Now any node's search finds the freshly-distilled skill.
    const matches = await bus.requestRemote<SkillMeta[]>(SKILLS_SEARCH_SUBJECT, { query: "resize images in a folder" }, 4000);
    expect(matches.map((m) => m.name)).toContain("resize-images");

    // A node can delete a personal skill it owns (personal-only; bundled are safe).
    const deleted = await bus.requestRemote<boolean>(SKILLS_DELETE_SUBJECT, { name: "resize-images" }, 4000);
    expect(deleted).toBe(true);
    const after = await bus.requestRemote<SkillMeta[]>(SKILLS_SEARCH_SUBJECT, { query: "resize images in a folder" }, 4000);
    expect(after.map((m) => m.name)).not.toContain("resize-images");
  }, 60_000);
});
