import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../logger";
import { computeWorkspaceHashes, type WorkspaceHashes } from "./hashing";

export type ValidationPhase =
  | "config"
  | "install"
  | "compile"
  | "missing_tests"
  | "tests"
  | "exception";

export interface ValidationResult {
  ok: boolean;
  type_name?: string;
  phase?: ValidationPhase;
  errors?: string;
  logs?: string;
  test_summary?: { total: number; passed: number; failed: number };
  hashes: WorkspaceHashes;
  validated_at: number;
}

export interface BrainState {
  ok: boolean;
  type_name?: string;
  phase?: ValidationPhase;
  errors?: string;
  test_summary?: { total: number; passed: number; failed: number };
  hashes: WorkspaceHashes;
  validated_at: number;
}

const STATE_FILE = ".brain-state.json";
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_COMPILE_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

export interface ValidatorOptions {
  install_timeout_ms?: number;
  compile_timeout_ms?: number;
  test_timeout_ms?: number;
}

export class TypeValidatorService {
  private readonly log = logger.child({ svc: "validator" });

  constructor(private readonly opts: ValidatorOptions = {}) {}

  async validate(workspacePath: string): Promise<ValidationResult> {
    const hashes = computeWorkspaceHashes(workspacePath);
    const now = Date.now();

    const configPath = path.join(workspacePath, "config.json");
    if (!fs.existsSync(configPath)) {
      return this.finish(workspacePath, {
        ok: false, phase: "config", errors: "config.json not found",
        hashes, validated_at: now,
      });
    }

    let typeName: string;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { name?: string };
      if (!cfg.name) {
        return this.finish(workspacePath, {
          ok: false, phase: "config", errors: "config.json missing 'name'",
          hashes, validated_at: now,
        });
      }
      typeName = cfg.name;
    } catch (err) {
      return this.finish(workspacePath, {
        ok: false, phase: "config",
        errors: `config.json invalid: ${err instanceof Error ? err.message : String(err)}`,
        hashes, validated_at: now,
      });
    }

    // Install step — skip if node_modules exists and deps_hash unchanged
    const priorState = readState(workspacePath);
    const needsInstall = !fs.existsSync(path.join(workspacePath, "node_modules"))
      || priorState?.hashes.deps_hash !== hashes.deps_hash;
    if (needsInstall) {
      const install = await runCmd("pnpm install --no-frozen-lockfile", workspacePath, this.opts.install_timeout_ms ?? DEFAULT_INSTALL_TIMEOUT_MS);
      if (install.exitCode !== 0) {
        return this.finish(workspacePath, {
          ok: false, type_name: typeName, phase: "install",
          errors: trimOutput(install.stderr || install.stdout), logs: trimOutput(install.stdout),
          hashes, validated_at: now,
        });
      }
    }

    // Compile — always run, idempotent if dist is up to date
    const compile = await runCmd("npx tsc", workspacePath, this.opts.compile_timeout_ms ?? DEFAULT_COMPILE_TIMEOUT_MS);
    if (compile.exitCode !== 0) {
      return this.finish(workspacePath, {
        ok: false, type_name: typeName, phase: "compile",
        errors: trimOutput(compile.stdout || compile.stderr),
        hashes: computeWorkspaceHashes(workspacePath), validated_at: now,
      });
    }

    // Re-hash after compile (dist may have changed)
    const postBuildHashes = computeWorkspaceHashes(workspacePath);

    // Mandatory tests
    const testDir = path.join(workspacePath, "tests");
    const hasTests = fs.existsSync(testDir) && findTestFiles(testDir).length > 0;
    if (!hasTests) {
      return this.finish(workspacePath, {
        ok: false, type_name: typeName, phase: "missing_tests",
        errors: "No test files found. Create tests/<something>.test.ts with at least one test that exercises the handler.",
        hashes: postBuildHashes, validated_at: now,
      });
    }

    const test = await runCmd("npx vitest run", workspacePath, this.opts.test_timeout_ms ?? DEFAULT_TEST_TIMEOUT_MS);
    const summary = parseVitestSummary(test.stdout + "\n" + test.stderr);
    if (test.exitCode !== 0 || (summary && summary.failed > 0)) {
      return this.finish(workspacePath, {
        ok: false, type_name: typeName, phase: "tests",
        errors: trimOutput(test.stdout || test.stderr),
        test_summary: summary ?? undefined,
        hashes: postBuildHashes, validated_at: now,
      });
    }

    return this.finish(workspacePath, {
      ok: true, type_name: typeName, test_summary: summary ?? undefined,
      hashes: postBuildHashes, validated_at: now,
    });
  }

  private finish(workspacePath: string, result: ValidationResult): ValidationResult {
    writeState(workspacePath, {
      ok: result.ok,
      type_name: result.type_name,
      phase: result.phase,
      errors: result.errors,
      test_summary: result.test_summary,
      hashes: result.hashes,
      validated_at: result.validated_at,
    });
    if (result.ok) {
      this.log.info({ workspace: workspacePath, type: result.type_name }, "Validated");
    } else {
      this.log.warn({ workspace: workspacePath, phase: result.phase }, "Validation failed");
    }
    return result;
  }
}

export function readState(workspacePath: string): BrainState | null {
  const p = path.join(workspacePath, STATE_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BrainState;
  } catch {
    return null;
  }
}

function writeState(workspacePath: string, state: BrainState): void {
  const p = path.join(workspacePath, STATE_FILE);
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && /\.test\.(ts|js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function parseVitestSummary(output: string): { total: number; passed: number; failed: number } | null {
  const passedMatch = output.match(/Tests\s+(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  if (!passedMatch && !failedMatch) return null;
  const passed = passedMatch ? Number(passedMatch[1]) : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  return { total: passed + failed, passed, failed };
}

function trimOutput(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 4000) return trimmed;
  return trimmed.slice(0, 2000) + "\n...[truncated]...\n" + trimmed.slice(-2000);
}

function runCmd(cmd: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
    });
  });
}
