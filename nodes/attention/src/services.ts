/**
 * Subprocess lifecycle for the standalone services the attention node
 * sits on top of (voice, gaze, intent).
 *
 * The attention node is the operator-facing entry point: running it
 * should also bring up the three backends. We spawn each via the root
 * `pnpm dev:<name>` script so they get the same wiring as when launched
 * manually, then wait for their /api/health to turn green before
 * letting the rest of the handler start polling.
 *
 * Set ATTENTION_SKIP_SERVICES=1 to disable spawning (useful when running
 * the services separately in other terminals).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "@brain/core";

const log = logger.child({ node: "attention.services" });

export type ServiceSpec = {
  name: string;
  script: string;      // e.g. "dev:voice"
  healthUrl: string;   // e.g. "http://127.0.0.1:8765/api/health"
  webUrl: string;      // e.g. "http://127.0.0.1:5174/"
};

export const DEFAULT_SERVICES: ServiceSpec[] = [
  { name: "voice",  script: "dev:voice",  healthUrl: "http://127.0.0.1:8765/api/health", webUrl: "http://127.0.0.1:5174/" },
  { name: "gaze",   script: "dev:gaze",   healthUrl: "http://127.0.0.1:8766/api/health", webUrl: "http://127.0.0.1:5175/" },
  { name: "intent", script: "dev:intent", healthUrl: "http://127.0.0.1:8767/api/health", webUrl: "http://127.0.0.1:5176/" },
];

const spawned: ChildProcess[] = [];

export function skipAutoSpawn(): boolean {
  return process.env.ATTENTION_SKIP_SERVICES === "1";
}

async function isHealthy(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(to);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(url: string, label: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(url)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`service ${label} did not become healthy within ${timeoutMs}ms`);
}

function spawnService(svc: ServiceSpec, repoRoot: string): ChildProcess {
  log.info({ name: svc.name, script: svc.script }, "spawning service");
  const proc = spawn("pnpm", ["run", svc.script], {
    cwd: repoRoot,
    // stdio inherit so the dev console keeps its existing per-service
    // coloured logs instead of vanishing behind the attention node.
    stdio: "inherit",
    detached: false,
  });
  proc.on("exit", (code, signal) => {
    log.warn({ name: svc.name, code, signal }, "service exited");
  });
  spawned.push(proc);
  return proc;
}

export async function ensureServices(
  services: ServiceSpec[] = DEFAULT_SERVICES,
  repoRoot: string = resolveRepoRoot(),
): Promise<void> {
  if (skipAutoSpawn()) {
    log.info("ATTENTION_SKIP_SERVICES=1 — not spawning, assuming services already up");
    await Promise.all(services.map((s) => waitHealthy(s.healthUrl, s.name, 5000).catch(() => {
      log.warn({ name: s.name }, "service not reachable (skip mode) — continuing anyway");
    })));
    return;
  }
  // For each, spawn only when BOTH the API health endpoint AND the
  // matching Vite web port answer — otherwise we'd happily skip a stale
  // half-running service (residual python uvicorn from a previous dev
  // session, no Vite) and the attention UI iframe would then fail to
  // load. Same logic for the user starting things separately: as long
  // as both ports are reachable we don't double-spawn.
  for (const svc of services) {
    const apiUp = await isHealthy(svc.healthUrl);
    const webUp = await isHealthy(svc.webUrl);
    if (apiUp && webUp) {
      log.info({ name: svc.name }, "service already up, skipping spawn");
      continue;
    }
    if (apiUp && !webUp) {
      log.warn(
        { name: svc.name },
        "API is up but web Vite is not — re-spawning full stack via dev script",
      );
    }
    spawnService(svc, repoRoot);
  }
  for (const svc of services) {
    await waitHealthy(svc.healthUrl, svc.name);
    log.info({ name: svc.name }, "service healthy");
  }
}

export function killAllServices(): void {
  for (const proc of spawned) {
    if (!proc.killed && proc.pid) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  spawned.length = 0;
}

function resolveRepoRoot(): string {
  // The compiled handler sits at nodes/attention/dist/handler.js, so the
  // repo root is four directories up from this module when bundled, or
  // three when running directly from TS. Walk up until package.json with
  // "brain-monorepo" name is found.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = require(`${dir}/package.json`);
      if (pkg.name === "brain-monorepo") return dir;
    } catch {
      /* keep walking */
    }
    const parent = dir.replace(/\/[^/]+$/, "");
    if (parent === dir) break;
    dir = parent;
  }
  log.warn({ cwd: process.cwd() }, "could not find repo root, falling back to cwd");
  return process.cwd();
}

// Best-effort cleanup on process signals so spawned services die with us.
for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) {
  process.once(sig, () => killAllServices());
}
