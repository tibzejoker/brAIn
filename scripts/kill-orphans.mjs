#!/usr/bin/env node
/**
 * Kill brAIn dev-stack orphans: API on 3000/3500, sister-repo Python
 * uvicorn children (voice/gaze/intent on 8765/8766/8767), plus any
 * nest --watch / dist/main hanging around.
 *
 * tsc-watch and nest --watch occasionally leak when the user force-quits
 * the terminal. Run this when port 3000 (or one of the uvicorn ports)
 * is stuck on EADDRINUSE.
 *
 * Usage: pnpm kill-orphans
 */
import { execSync } from "node:child_process";

const PORTS = [3000, 3500, 5173, 5174, 5175, 5176, 8765, 8766, 8767];
const CMD_PATTERNS = [
  "nest start.*api",
  "packages/api/dist/main",
  "uvicorn app\\.main",
  // Embedded NATS broker the API spawns at boot. Survives if the
  // parent gets SIGKILLed instead of going through onModuleDestroy.
  "packages/core/bin/nats-server",
];

function pidsOnPort(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    return out ? out.split("\n").map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function pidsByPattern(pattern) {
  try {
    const out = execSync(`pgrep -f "${pattern}"`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    return out ? out.split("\n").map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

const victims = new Set();
for (const port of PORTS) {
  for (const pid of pidsOnPort(port)) victims.add(pid);
}
for (const pat of CMD_PATTERNS) {
  for (const pid of pidsByPattern(pat)) victims.add(pid);
}
victims.delete(process.pid);  // never kill ourselves

if (victims.size === 0) {
  console.log("[kill-orphans] no orphans found — all clean.");
  process.exit(0);
}

console.log(`[kill-orphans] killing ${victims.size} process(es): ${[...victims].join(", ")}`);
for (const pid of victims) {
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

// Grace period for SIGTERM, then SIGKILL stragglers.
await new Promise((r) => setTimeout(r, 1000));
for (const pid of victims) {
  try { process.kill(pid, 0); } catch { continue; }  // already dead
  try {
    process.kill(pid, "SIGKILL");
    console.log(`[kill-orphans] SIGKILL ${pid} (didn't respond to SIGTERM)`);
  } catch { /* race */ }
}

console.log("[kill-orphans] done.");
