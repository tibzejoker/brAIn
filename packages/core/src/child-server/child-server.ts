import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../logger";

const PARENT_PID_ENV = "BRAIN_PARENT_PID";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const DEFAULT_KILL_GRACE_MS = 4_000;

export interface ChildServerOptions {
  /** Friendly name used in logs. */
  name: string;
  /** Health probe URL. If a 2xx is returned, the server is considered up. */
  healthUrl: string;
  /** Command to spawn (e.g. "uvicorn"). */
  command: string;
  /** Args (e.g. ["app.main:app", "--host", "127.0.0.1", "--port", "8765"]). */
  args: string[];
  /** Working directory for the child. */
  cwd: string;
  /** Extra env. BRAIN_PARENT_PID is appended automatically. */
  env?: Record<string, string>;
  /** Max wait for the health URL to respond after spawn. */
  startupTimeoutMs?: number;
  /** Poll cadence for the health URL during startup. */
  healthPollMs?: number;
  /** Time between SIGTERM and SIGKILL during teardown. */
  killGracePeriodMs?: number;
}

export interface ChildServerHandle {
  /** True when we spawned the process; false when we attached to an already-running server. */
  readonly spawned: boolean;
  /** PID of the spawned child (null when attached to existing). */
  readonly pid: number | null;
  /** Tear down. SIGTERM → grace → SIGKILL. No-op when attached. */
  kill(reason?: string): Promise<void>;
}

interface ActiveChild {
  proc: ChildProcess;
  killed: boolean;
  cleanup: () => void;
}

const activeChildren = new Set<ActiveChild>();
let processHandlersInstalled = false;

function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  const onExit = (signal?: NodeJS.Signals): void => {
    for (const child of activeChildren) {
      if (child.killed || child.proc.killed) continue;
      try { child.proc.kill(signal ?? "SIGTERM"); } catch { /* already dead */ }
    }
  };

  process.on("SIGTERM", () => onExit("SIGTERM"));
  process.on("SIGINT", () => onExit("SIGINT"));
  process.on("SIGHUP", () => onExit("SIGHUP"));
  // exit fires after the loop drains. Synchronous final sweep.
  process.on("exit", () => onExit());
}

export async function startChildServer(opts: ChildServerOptions): Promise<ChildServerHandle> {
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollMs = opts.healthPollMs ?? DEFAULT_HEALTH_POLL_MS;
  const grace = opts.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;

  // Already running? Attach instead of spawning. This keeps `pnpm dev:voice`
  // and node-spawned modes coexisting cleanly during local development.
  if (await probeHealth(opts.healthUrl)) {
    logger.info({ name: opts.name, healthUrl: opts.healthUrl }, "child-server: attached to existing");
    return {
      spawned: false,
      pid: null,
      kill: () => Promise.resolve(),
    };
  }

  installProcessHandlers();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    [PARENT_PID_ENV]: String(process.pid),
  };

  logger.info({ name: opts.name, command: opts.command, args: opts.args, cwd: opts.cwd },
    "child-server: spawning");

  const proc = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Capture spawn errors (ENOENT, EACCES, …). Without a listener, an 'error'
  // event from a failed spawn would crash the parent process.
  const spawnErrorRef: { current: Error | null } = { current: null };
  proc.on("error", (err: Error) => {
    spawnErrorRef.current = err;
    logger.error({ name: opts.name, command: opts.command, err: err.message },
      "child-server: process error");
  });

  if (proc.pid === undefined) {
    throw new Error(`child-server: failed to spawn ${opts.command}: ${spawnErrorRef.current?.message ?? "unknown"}`);
  }

  const onStdout = (buf: Buffer): void => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim()) logger.info({ name: opts.name, pid: proc.pid }, line);
    }
  };
  const onStderr = (buf: Buffer): void => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim()) logger.warn({ name: opts.name, pid: proc.pid }, line);
    }
  };
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", onStderr);

  const active: ActiveChild = {
    proc,
    killed: false,
    cleanup: () => {
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
    },
  };
  activeChildren.add(active);

  proc.on("exit", (code, signal) => {
    active.killed = true;
    active.cleanup();
    activeChildren.delete(active);
    logger.info({ name: opts.name, pid: proc.pid, code, signal }, "child-server: exited");
  });

  try {
    await waitForHealthy(opts.healthUrl, startupTimeoutMs, pollMs, proc);
  } catch (err) {
    await terminate(active, grace);
    throw err;
  }

  logger.info({ name: opts.name, pid: proc.pid }, "child-server: ready");

  return {
    spawned: true,
    pid: proc.pid,
    kill: (reason?: string) => {
      logger.info({ name: opts.name, pid: proc.pid, reason }, "child-server: killing");
      return terminate(active, grace);
    },
  };
}

async function waitForHealthy(
  url: string,
  timeoutMs: number,
  pollMs: number,
  proc: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`child-server: process exited (code=${proc.exitCode}) before becoming healthy`);
    }
    if (await probeHealth(url)) return;
    await sleep(pollMs);
  }
  throw new Error(`child-server: health check at ${url} timed out after ${timeoutMs}ms`);
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function terminate(active: ActiveChild, graceMs: number): Promise<void> {
  if (active.killed || active.proc.exitCode !== null) {
    activeChildren.delete(active);
    return;
  }
  const proc = active.proc;
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", () => resolve());
  });

  try { proc.kill("SIGTERM"); } catch { /* already gone */ }

  const timer = sleep(graceMs).then(() => {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  await Promise.race([exited, timer]);
  // If grace expired and SIGKILL was sent, still wait for the OS to reap.
  await exited;
  activeChildren.delete(active);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
