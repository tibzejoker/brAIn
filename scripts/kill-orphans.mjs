#!/usr/bin/env node
/**
 * Kill brAIn dev-stack orphans — anything holding a dev port or matching
 * a known leftover process name from `nest --watch`, `tsc --watch`, the
 * embedded NATS broker, or sister-repo Python sidecars.
 *
 * Common cause: force-quitting the terminal mid-`pnpm start` leaves the
 * tsc/nest/uvicorn children hanging on EADDRINUSE :3000 (or :8765, …).
 *
 *   pnpm kill-orphans              # default set
 *   pnpm kill-orphans 3000 8767    # only these ports (+ default patterns)
 *   pnpm kill-orphans --ports-only # skip command-pattern matching
 *   pnpm kill-orphans --no-grace   # SIGKILL immediately (no SIGTERM first)
 *
 * Cross-platform: lsof / pgrep on macOS+Linux, netstat / taskkill on
 * Windows. Pattern matching is best-effort on Windows (uses tasklist).
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

const DEFAULT_PORTS = [3000, 3500, 5173, 5174, 5175, 5176, 8765, 8766, 8767];
const DEFAULT_PATTERNS = [
  "nest start.*api",
  "packages/api/dist/main",
  "uvicorn app\\.main",
  // Embedded NATS broker the API spawns at boot — survives if the parent
  // gets SIGKILLed instead of going through onModuleDestroy.
  "packages/core/bin/nats-server",
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const portArgs = args.filter((a) => !a.startsWith("--")).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
const ports = portArgs.length > 0 ? portArgs : DEFAULT_PORTS;

const isWindows = platform() === "win32";
const usePatterns = !flags.has("--ports-only");
const noGrace = flags.has("--no-grace");

function pidsOnPortUnix(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; }
}

function pidsOnPortWindows(port) {
  // netstat -ano lines look like:
  //   TCP    0.0.0.0:8767    0.0.0.0:0    LISTENING    37652
  let out = "";
  try { out = execSync("netstat -ano -p tcp", { encoding: "utf8" }); } catch { return []; }
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && Number(m[1]) === port) pids.push(Number(m[2]));
  }
  return pids;
}

function pidsByPatternUnix(pattern) {
  try {
    const out = execSync(`pgrep -f "${pattern}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; }
}

function pidsByPatternWindows(pattern) {
  // No pgrep on Windows — best-effort: WMIC's CommandLine column.
  let out = "";
  try {
    out = execSync(`wmic process get processid,commandline /format:csv`, { encoding: "utf8" });
  } catch { return []; }
  const rx = new RegExp(pattern);
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!rx.test(line)) continue;
    const m = line.match(/,(\d+)\s*$/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

const pidsOnPort = isWindows ? pidsOnPortWindows : pidsOnPortUnix;
const pidsByPattern = isWindows ? pidsByPatternWindows : pidsByPatternUnix;

const victims = new Map();   // pid → reason (e.g. "port :3000" or "pattern: nest start")
for (const port of ports) {
  for (const pid of pidsOnPort(port)) {
    if (pid !== process.pid && !victims.has(pid)) victims.set(pid, `:${port}`);
  }
}
if (usePatterns) {
  for (const pat of DEFAULT_PATTERNS) {
    for (const pid of pidsByPattern(pat)) {
      if (pid !== process.pid && !victims.has(pid)) victims.set(pid, `~ ${pat}`);
    }
  }
}

if (victims.size === 0) {
  console.log("[kill-orphans] no orphans found — all clean.");
  process.exit(0);
}

console.log(`[kill-orphans] killing ${victims.size} process(es):`);
for (const [pid, reason] of victims) console.log(`  pid ${pid}  (${reason})`);

function sendSignal(pid, signal) {
  try {
    if (isWindows) execSync(`taskkill ${signal === "SIGKILL" ? "/F" : ""} /PID ${pid}`, { stdio: "ignore" });
    else process.kill(pid, signal);
    return true;
  } catch { return false; }
}

if (noGrace) {
  for (const pid of victims.keys()) sendSignal(pid, "SIGKILL");
} else {
  // Graceful — SIGTERM then SIGKILL stragglers after 1s. Windows taskkill
  // is unconditional (no SIGTERM semantics) so the grace step is moot
  // there; we just skip it.
  if (!isWindows) {
    for (const pid of victims.keys()) sendSignal(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    for (const pid of victims.keys()) {
      try { process.kill(pid, 0); } catch { continue; }   // already dead
      sendSignal(pid, "SIGKILL");
      console.log(`[kill-orphans] SIGKILL ${pid} (didn't respond to SIGTERM)`);
    }
  } else {
    for (const pid of victims.keys()) sendSignal(pid, "SIGKILL");
  }
}

console.log(`[kill-orphans] done — ${victims.size} process(es) killed.`);
