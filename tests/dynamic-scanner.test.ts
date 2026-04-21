import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BusService, TypeRegistry, DynamicTypeScanner, type ValidationResult, TypeValidatorService, computeWorkspaceHashes } from "@brain/core";

/**
 * Minimal stub validator: records calls and returns a configurable result.
 * Writes .brain-state.json with the REAL current hashes of the workspace so
 * the scanner's skip-logic can correctly compare against later ticks.
 */
function stubValidator(response: (workspace: string) => Omit<ValidationResult, "hashes">): TypeValidatorService {
  const v = new TypeValidatorService();
  v.validate = vi.fn(async (workspace: string) => {
    const partial = response(workspace);
    const result: ValidationResult = { ...partial, hashes: computeWorkspaceHashes(workspace) };
    fs.writeFileSync(path.join(workspace, ".brain-state.json"), JSON.stringify({
      ok: result.ok,
      type_name: result.type_name,
      phase: result.phase,
      errors: result.errors,
      hashes: result.hashes,
      validated_at: result.validated_at,
    }, null, 2));
    return result;
  }) as typeof v.validate;
  return v;
}

function writeWorkspace(dir: string, slug: string, opts: { withDist?: boolean } = {}): string {
  const ws = path.join(dir, slug);
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "config.json"), JSON.stringify({ name: slug }));
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: `@brain/node-${slug}` }));
  fs.writeFileSync(path.join(ws, "src", "handler.ts"), "export const handler = async () => {};");
  if (opts.withDist !== false) {
    fs.mkdirSync(path.join(ws, "dist"));
    fs.writeFileSync(path.join(ws, "dist", "handler.js"), "module.exports.handler = async () => {};");
  }
  return ws;
}

describe("DynamicTypeScanner", () => {
  let tmpDir: string;
  let bus: BusService;
  let registry: TypeRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-scanner-"));
    bus = new BusService();
    registry = new TypeRegistry();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers validation after the debounce window and registers on success", async () => {
    writeWorkspace(tmpDir, "alpha");
    const validator = stubValidator(() => ({
      ok: true, type_name: "alpha", validated_at: Date.now(),
    }));

    const scanner = new DynamicTypeScanner({
      dynamicDir: tmpDir, bus, typeRegistry: registry, validator,
      debounce_ms: 0, interval_ms: 1000,
    });

    const events: string[] = [];
    bus.on("message:published", (m) => { events.push(m.topic); });

    // First tick records the hash; second tick (past debounce) triggers validation
    await scanner.tick();
    await scanner.tick();

    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(registry.has("alpha")).toBe(true);
    expect(events).toContain("types.validated");
    expect(events).toContain("types.registered");
  });

  it("publishes types.validation_failed on failed validation and does not register", async () => {
    writeWorkspace(tmpDir, "beta");
    const validator = stubValidator(() => ({
      ok: false, type_name: "beta", phase: "tests", errors: "1 test failed",
      validated_at: Date.now(),
    }));

    const scanner = new DynamicTypeScanner({
      dynamicDir: tmpDir, bus, typeRegistry: registry, validator, debounce_ms: 0,
    });

    const events: Array<{ topic: string; content: string }> = [];
    bus.on("message:published", (m) => {
      events.push({ topic: m.topic, content: (m.payload as { content: string }).content });
    });

    await scanner.tick();
    await scanner.tick();

    expect(registry.has("beta")).toBe(false);
    const failed = events.find((e) => e.topic === "types.validation_failed");
    expect(failed).toBeDefined();
    const payload = JSON.parse(failed!.content) as { slug: string; phase: string };
    expect(payload.slug).toBe("beta");
    expect(payload.phase).toBe("tests");
  });

  it("skips validation when hash matches last failed build (no revalidation loop)", async () => {
    writeWorkspace(tmpDir, "gamma");
    const validator = stubValidator(() => ({
      ok: false, type_name: "gamma", phase: "compile", errors: "broken",
      validated_at: Date.now(),
    }));

    const scanner = new DynamicTypeScanner({
      dynamicDir: tmpDir, bus, typeRegistry: registry, validator, debounce_ms: 0,
    });

    await scanner.tick();
    await scanner.tick();  // triggers first validation
    await scanner.tick();  // should NOT re-validate (build hash unchanged + already failed)

    expect(validator.validate).toHaveBeenCalledTimes(1);
  });

  it("skips workspaces with no dist/ (no build yet)", async () => {
    writeWorkspace(tmpDir, "delta", { withDist: false });
    const validator = stubValidator(() => ({
      ok: true, type_name: "delta", validated_at: Date.now(),
    }));

    const scanner = new DynamicTypeScanner({
      dynamicDir: tmpDir, bus, typeRegistry: registry, validator, debounce_ms: 0,
    });

    await scanner.tick();
    await scanner.tick();
    await scanner.tick();

    expect(validator.validate).not.toHaveBeenCalled();
  });

  it("re-registers as types.updated when an already-registered type rebuilds with new hash", async () => {
    const ws = writeWorkspace(tmpDir, "epsilon");
    const validator = stubValidator(() => ({
      ok: true, type_name: "epsilon", validated_at: Date.now(),
    }));

    const scanner = new DynamicTypeScanner({
      dynamicDir: tmpDir, bus, typeRegistry: registry, validator, debounce_ms: 0,
    });

    // First round: register
    await scanner.tick();
    await scanner.tick();
    expect(registry.has("epsilon")).toBe(true);

    // Change dist to force new hash
    fs.writeFileSync(path.join(ws, "dist", "handler.js"), "module.exports.handler = async () => { /* v2 */ };");

    const events: string[] = [];
    bus.on("message:published", (m) => { events.push(m.topic); });

    await scanner.tick();  // record new hash
    await scanner.tick();  // validate → types.updated

    expect(events).toContain("types.updated");
  });
});
