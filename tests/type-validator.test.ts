import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { computeWorkspaceHashes, hashDir, readState, TypeValidatorService } from "@brain/core";

describe("computeWorkspaceHashes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-hash-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty strings for an empty workspace", () => {
    const h = computeWorkspaceHashes(tmpDir);
    expect(h.build_hash).toBe("");
    expect(h.deps_hash).toBe("");
  });

  it("is deterministic for the same content", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ name: "x" }));
    const h1 = computeWorkspaceHashes(tmpDir);
    const h2 = computeWorkspaceHashes(tmpDir);
    expect(h1.source_hash).toBe(h2.source_hash);
    expect(h1.source_hash).not.toBe("");
  });

  it("changes the build_hash when dist content changes", () => {
    fs.mkdirSync(path.join(tmpDir, "dist"));
    fs.writeFileSync(path.join(tmpDir, "dist", "handler.js"), "module.exports = {};");
    const h1 = computeWorkspaceHashes(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "dist", "handler.js"), "module.exports = { x: 1 };");
    const h2 = computeWorkspaceHashes(tmpDir);
    expect(h1.build_hash).not.toBe(h2.build_hash);
  });

  it("changes the deps_hash only when dependencies change", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0", dependencies: { foo: "^1.0.0" },
    }));
    const h1 = computeWorkspaceHashes(tmpDir);

    // rewriting same deps in different order → same hash
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      version: "1.0.0", name: "x", dependencies: { foo: "^1.0.0" },
    }));
    const h2 = computeWorkspaceHashes(tmpDir);
    expect(h1.deps_hash).toBe(h2.deps_hash);

    // bumping the dep → different hash
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "x", dependencies: { foo: "^2.0.0" },
    }));
    const h3 = computeWorkspaceHashes(tmpDir);
    expect(h1.deps_hash).not.toBe(h3.deps_hash);
  });

  it("ignores node_modules and .brain-state.json in hashDir", () => {
    fs.mkdirSync(path.join(tmpDir, "nested", "node_modules", "foo"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "nested", "node_modules", "foo", "x.js"), "junk");
    fs.writeFileSync(path.join(tmpDir, "nested", ".brain-state.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "nested", "a.js"), "a");
    const hWithModules = hashDir(path.join(tmpDir, "nested"));

    fs.rmSync(path.join(tmpDir, "nested", "node_modules"), { recursive: true });
    fs.unlinkSync(path.join(tmpDir, "nested", ".brain-state.json"));
    const hWithout = hashDir(path.join(tmpDir, "nested"));
    expect(hWithModules).toBe(hWithout);
  });
});

describe("TypeValidatorService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-validator-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails with phase=config when config.json is missing", async () => {
    const validator = new TypeValidatorService();
    const r = await validator.validate(tmpDir);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("config");
    expect(fs.existsSync(path.join(tmpDir, ".brain-state.json"))).toBe(true);
    expect(readState(tmpDir)?.ok).toBe(false);
  });

  it("fails with phase=config when config.json has no 'name' field", async () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ description: "oops" }));
    const validator = new TypeValidatorService();
    const r = await validator.validate(tmpDir);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("config");
  });

  it("fails with phase=config when config.json is invalid JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json");
    const validator = new TypeValidatorService();
    const r = await validator.validate(tmpDir);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("config");
  });

  it("writes .brain-state.json on failure with current hashes", async () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({}));
    const validator = new TypeValidatorService();
    await validator.validate(tmpDir);
    const state = readState(tmpDir);
    expect(state).not.toBeNull();
    expect(state?.hashes).toBeDefined();
    expect(state?.validated_at).toBeGreaterThan(0);
  });
});
