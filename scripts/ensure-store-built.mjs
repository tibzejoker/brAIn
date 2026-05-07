#!/usr/bin/env node
// Make sure every cloned storeproject's nodes have a `dist/` so the
// API can `require(node.dir)` at boot. `clone-store.mjs` only clones
// — the storeproject node packages are part of the brAIn root pnpm
// workspace (see pnpm-workspace.yaml), but their `tsc` build is not
// run anywhere, so seed time crashes with MODULE_NOT_FOUND.
//
// Idempotent: skips when every storeproject node already has a dist/.
// Set BRAIN_SKIP_STORE_BUILD=1 to bypass entirely.

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const STORE_ROOT = resolve(FRAMEWORK_ROOT, "..", "storeprojects");

const IS_WIN = process.platform === "win32";

function log(msg) { process.stderr.write(`ensure-store-built: ${msg}\n`); }

if (process.env.BRAIN_SKIP_STORE_BUILD === "1") {
  log("skipped (BRAIN_SKIP_STORE_BUILD=1)");
  process.exit(0);
}

if (!existsSync(STORE_ROOT)) {
  log(`no storeprojects/ at ${STORE_ROOT} — nothing to build`);
  process.exit(0);
}

function listDirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => resolve(p, d.name));
}

function nodeNeedsBuild(nodeDir) {
  const src = resolve(nodeDir, "src");
  const pkg = resolve(nodeDir, "package.json");
  const dist = resolve(nodeDir, "dist");
  if (!existsSync(src) || !existsSync(pkg)) return false;
  return !existsSync(dist);
}

const toBuild = [];
for (const projectDir of listDirs(STORE_ROOT)) {
  const nodesDir = resolve(projectDir, "nodes");
  if (!existsSync(nodesDir)) continue;
  for (const nodeDir of listDirs(nodesDir)) {
    if (nodeNeedsBuild(nodeDir)) toBuild.push(nodeDir);
  }
}

if (toBuild.length === 0) {
  log("all storeproject nodes already built");
  process.exit(0);
}

log(`${toBuild.length} node(s) need build:`);
for (const d of toBuild) log(`  - ${relative(FRAMEWORK_ROOT, d)}`);

// Use one pnpm invocation with multiple --filter <path> so we only
// build what's actually missing. pnpm requires *relative* paths for
// directory-based filters (absolute paths silently match nothing).
const filters = toBuild.flatMap((d) => {
  const rel = relative(FRAMEWORK_ROOT, d).replace(/\\/g, "/");
  return ["--filter", `./${rel}`];
});
const r = spawnSync("pnpm", [...filters, "run", "build"], {
  cwd: FRAMEWORK_ROOT,
  stdio: "inherit",
  env: process.env,
  shell: IS_WIN,
});

if (r.error) {
  log(`pnpm spawn failed: ${r.error.message}`);
  process.exit(0);
}
if (r.status !== 0) {
  log(`pnpm build exited with code ${r.status}`);
  // Don't fail the launcher — partial progress is still useful and
  // the API will surface a precise error per missing handler.
}

process.exit(0);
