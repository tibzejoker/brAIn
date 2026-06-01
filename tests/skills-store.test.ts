import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "@brain/core";

function writeSkill(root: string, name: string, fm: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n${fm}\n---\n\n# ${name}\n\nbody\n`, "utf-8");
}

describe("SkillStore: 3-tier scope + node filtering", () => {
  let root: string;
  let store: SkillStore;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "skillstore-"));
    // capability skill (always available once installed)
    writeSkill(root, "web-fetch", "description: Fetch a URL via http-bridge.");
    // node-scoped skill (only when a `tts` instance is spawned)
    writeSkill(root, "operate-tts", "description: Speak via a running tts node.\nrequires_node: tts");
    store = new SkillStore({ skillsDir: root });
  });

  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("exposes requires_node from frontmatter", () => {
    const all = store.list();
    expect(all.find((s) => s.name === "operate-tts")?.requiresNode).toBe("tts");
    expect(all.find((s) => s.name === "web-fetch")?.requiresNode).toBeUndefined();
  });

  it("unfiltered (dashboard browse) shows every skill", () => {
    expect(store.list().map((s) => s.name).sort()).toEqual(["operate-tts", "web-fetch"]);
  });

  it("with no node spawned, hides the node-scoped skill but keeps the capability one", () => {
    const names = store.list(new Set<string>()).map((s) => s.name);
    expect(names).toContain("web-fetch");
    expect(names).not.toContain("operate-tts");
  });

  it("surfaces the node-scoped skill once its node type is live", () => {
    const names = store.list(new Set(["tts"])).map((s) => s.name);
    expect(names).toContain("web-fetch");
    expect(names).toContain("operate-tts");
  });

  it("search applies the same node filter", () => {
    expect(store.search("speak tts", 5, new Set<string>()).map((s) => s.name)).not.toContain("operate-tts");
    expect(store.search("speak tts", 5, new Set(["tts"])).map((s) => s.name)).toContain("operate-tts");
  });
});
