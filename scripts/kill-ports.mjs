#!/usr/bin/env node
/**
 * Kill anything listening on brAIn dev ports — frees stale orphans before
 * a fresh `pnpm dev:*` run.
 *
 * Default ports: 3000 (api), 5173 (dashboard/vite), 8765 (voice), 8766
 * (gaze), 8767 (intent). Override with comma-separated CLI args:
 *
 *   node scripts/kill-ports.mjs            # default set
 *   node scripts/kill-ports.mjs 3000 8767  # only these two
 *
 * Cross-platform: uses `netstat`/`taskkill` on Windows, `lsof`/`kill` on
 * macOS and Linux. Skips ports with no listener (silent no-op).
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

const DEFAULT_PORTS = [3000, 5173, 8765, 8766, 8767];

const ports = (process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : DEFAULT_PORTS.map(String)
).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);

const isWindows = platform() === "win32";

function pidsOnPortWindows(port) {
  // netstat -ano lines look like:
  //   TCP    0.0.0.0:8767    0.0.0.0:0    LISTENING    37652
  let out = "";
  try {
    out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
  } catch {
    return new Set();
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return pids;
}

function pidsOnPortUnix(port) {
  // lsof -ti tcp:PORT -sTCP:LISTEN gives one PID per line.
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
    );
  } catch {
    return new Set();
  }
}

function killPid(pid) {
  try {
    if (isWindows) {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

let total = 0;
for (const port of ports) {
  const pids = isWindows ? pidsOnPortWindows(port) : pidsOnPortUnix(port);
  if (pids.size === 0) {
    console.log(`[kill-ports] :${port} — free`);
    continue;
  }
  for (const pid of pids) {
    const ok = killPid(pid);
    console.log(`[kill-ports] :${port} ${ok ? "killed" : "FAILED to kill"} pid ${pid}`);
    if (ok) total += 1;
  }
}

console.log(`[kill-ports] done — ${total} process(es) killed across ${ports.length} port(s)`);
