#!/usr/bin/env node
// Clone tibzejoker/brAIn-store as a sibling of this checkout if it
// isn't there yet. Idempotent — does nothing when the dir exists.
//
// Run automatically by the framework's postinstall. Users who don't
// want network at install time can set BRAIN_NO_STORE_CLONE=1.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.BRAIN_NO_STORE_CLONE === "1") {
  console.error("clone-store: skipped (BRAIN_NO_STORE_CLONE=1)");
  process.exit(0);
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const SIBLINGS_ROOT = resolve(FRAMEWORK_ROOT, "..");
const STORE_DIR = resolve(SIBLINGS_ROOT, "brAIn-store");

if (existsSync(STORE_DIR)) {
  console.error(`clone-store: ${STORE_DIR} already exists, skipping`);
  process.exit(0);
}

const URL = "https://github.com/tibzejoker/brAIn-store.git";
console.error(`clone-store: cloning ${URL} → ${STORE_DIR}`);
const r = spawnSync("git", ["clone", "--depth", "1", URL, STORE_DIR], {
  stdio: "inherit",
});
if (r.status !== 0) {
  console.error("clone-store: clone failed (network? no git?). Marketplace will be HTTP-fetched at runtime instead.");
  process.exit(0);  // non-fatal: HTTP fallback in StoreService
}
console.error("clone-store: done");
