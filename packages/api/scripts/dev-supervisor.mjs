#!/usr/bin/env node
// Dev supervisor — replaces `nest start --watch` because it doesn't
// respawn the API on a clean process.exit(0), which the dashboard's
// "Open to network" toggle relies on.
//
// What it does:
//   - Runs `tsc -w` once in the background (compiles src → dist on
//     changes, keeps the type checker hot).
//   - Waits for dist/main.js, then spawns it as the API.
//   - Restarts the API when:
//       * dist/main.js changes (tsc just recompiled)
//       * the API exits (file change OR process.exit(0) from the
//         broker bind toggle)
//   - Forwards SIGINT/SIGTERM down so Ctrl-C still tears down cleanly.

import { spawn } from "node:child_process";
import { existsSync, watch as fsWatch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const ENTRY = resolve(API_DIR, "dist", "main.js");

let api = null;
let restarting = false;
let stopping = false;

function spawnTsc() {
  const t = spawn("npx", ["tsc", "-w", "--preserveWatchOutput"], {
    cwd: API_DIR, stdio: ["ignore", "inherit", "inherit"], env: process.env,
  });
  t.on("exit", () => {
    if (!stopping) process.stderr.write("[dev-supervisor] tsc -w exited unexpectedly\n");
  });
  return t;
}

function spawnApi() {
  if (!existsSync(ENTRY)) {
    process.stderr.write(`[dev-supervisor] ${ENTRY} not yet built — waiting…\n`);
    return null;
  }
  process.stderr.write(`[dev-supervisor] starting API\n`);
  const a = spawn(process.execPath, ["--enable-source-maps", ENTRY], {
    cwd: API_DIR, stdio: "inherit", env: process.env,
  });
  a.on("exit", (code, signal) => {
    api = null;
    if (stopping || restarting) return;
    if (code === 0) {
      process.stderr.write(`[dev-supervisor] API exited cleanly — restarting\n`);
      setTimeout(() => { api = spawnApi(); }, 250);
    } else {
      process.stderr.write(`[dev-supervisor] API exited code=${code} signal=${signal} — waiting for next dist change to retry\n`);
    }
  });
  return a;
}

async function restartApi() {
  if (restarting) return;
  restarting = true;
  if (api && !api.killed) {
    api.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (api && !api.killed) api.kill("SIGKILL");
  }
  restarting = false;
  api = spawnApi();
}

const tsc = spawnTsc();

// Wait briefly for the first compile, then start the API. If the
// initial build fails the file watcher below will pick up the
// successful compile when it lands.
const tryStart = setInterval(() => {
  if (existsSync(ENTRY)) {
    clearInterval(tryStart);
    api = spawnApi();
  }
}, 200);

// Watch the entry for content changes (tsc emits → respawn).
let watchDebounce = null;
fsWatch(API_DIR, { recursive: true }, (event, filename) => {
  if (!filename || !filename.startsWith("dist/")) return;
  if (!filename.endsWith("main.js")) return;
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => { void restartApi(); }, 150);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (api && !api.killed) api.kill(sig);
    if (tsc && !tsc.killed) tsc.kill(sig);
    setTimeout(() => process.exit(0), 500);
  });
}
