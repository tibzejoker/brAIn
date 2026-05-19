#!/usr/bin/env node
// Rebuild @brain/sdk, @brain/core, @brain/agent if their `src/` is
// newer than their `dist/`. The API loads from the built dist, and
// `pnpm start` previously assumed `postinstall` had already produced
// fresh artifacts — which breaks the moment someone edits framework
// source between an `install` and a `start`. Symptom: API crashes on
// boot with `TypeError: (0 , core_1.<thing>) is not a function`,
// because the dist exports diverged from the source.
//
// Idempotent: skips when every package is already up to date.
// Set BRAIN_SKIP_FRAMEWORK_BUILD=1 to bypass entirely.

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGES = ["sdk", "core", "agent"];

const IS_WIN = process.platform === "win32";

function log(msg) { process.stderr.write(`ensure-framework-built: ${msg}\n`); }

if (process.env.BRAIN_SKIP_FRAMEWORK_BUILD === "1") {
  log("skipped (BRAIN_SKIP_FRAMEWORK_BUILD=1)");
  process.exit(0);
}

/** Latest mtime under a directory (recursive). Returns 0 if missing. */
function latestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        const m = statSync(p).mtimeMs;
        if (m > max) max = m;
      } catch { /* ignore */ }
    }
  }
  return max;
}

const stale = [];
for (const name of PACKAGES) {
  const pkgDir = resolve(FRAMEWORK_ROOT, "packages", name);
  if (!existsSync(pkgDir)) continue;
  const srcMtime = latestMtime(resolve(pkgDir, "src"));
  const distMtime = latestMtime(resolve(pkgDir, "dist"));
  // No dist OR src newer than dist → needs rebuild. Strict > so a
  // freshly-built package (src and dist with the same mtime) stays put.
  if (distMtime === 0 || srcMtime > distMtime) stale.push(name);
}

if (stale.length === 0) {
  log("framework packages up to date");
  process.exit(0);
}

log(`rebuilding: ${stale.map((n) => `@brain/${n}`).join(", ")}`);

// Build in dependency order: sdk → core → agent. pnpm with multiple
// --filter runs them sequentially when piped through `run build`, but
// to be safe we shell out per-package so a failure short-circuits.
for (const name of stale) {
  const r = spawnSync("pnpm", ["--filter", `@brain/${name}`, "build"], {
    cwd: FRAMEWORK_ROOT,
    stdio: "inherit",
    env: process.env,
    shell: IS_WIN,
  });
  if (r.error) {
    log(`spawn failed for @brain/${name}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    log(`build failed for @brain/${name} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

process.exit(0);
