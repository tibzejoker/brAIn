import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { startChildServer, type ChildServerHandle } from "../packages/core/src/child-server";

let workDir: string;
let scriptPath: string;
let stickyScriptPath: string;
let crashScriptPath: string;

const handles: ChildServerHandle[] = [];
const servers: Server[] = [];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-child-server-"));

  // Tiny HTTP server: /health → 200, also accepts SIGTERM gracefully.
  scriptPath = join(workDir, "server.js");
  writeFileSync(scriptPath, `
    const http = require("node:http");
    const port = parseInt(process.argv[2] ?? "0", 10);
    const server = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });
    server.listen(port);
    process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
    process.on("SIGINT", () => { server.close(() => process.exit(0)); });
  `);

  // Sticky variant: ignores SIGTERM — used to test SIGKILL escalation.
  stickyScriptPath = join(workDir, "sticky.js");
  writeFileSync(stickyScriptPath, `
    const http = require("node:http");
    const port = parseInt(process.argv[2] ?? "0", 10);
    const server = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });
    server.listen(port);
    process.on("SIGTERM", () => { /* ignored on purpose */ });
  `);

  // Crash variant: prints then exits — exercises "process died before healthy".
  crashScriptPath = join(workDir, "crash.js");
  writeFileSync(crashScriptPath, `
    console.error("boom");
    process.exit(7);
  `);
});

afterEach(async () => {
  while (handles.length) {
    const h = handles.pop();
    if (h) await h.kill("test cleanup");
  }
  while (servers.length) {
    const s = servers.pop();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
  });
}

describe("startChildServer", () => {
  it("attaches to an existing healthy server without spawning", async () => {
    const port = await pickPort();
    const existing = createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => existing.listen(port, "127.0.0.1", r));
    servers.push(existing);

    const handle = await startChildServer({
      name: "test",
      healthUrl: `http://127.0.0.1:${port}/health`,
      command: "node",
      args: [scriptPath, String(port)],
      cwd: workDir,
    });
    handles.push(handle);

    expect(handle.spawned).toBe(false);
    expect(handle.pid).toBeNull();
  });

  it("spawns a child and waits for /health", async () => {
    const port = await pickPort();
    const handle = await startChildServer({
      name: "test",
      healthUrl: `http://127.0.0.1:${port}/health`,
      command: "node",
      args: [scriptPath, String(port)],
      cwd: workDir,
      startupTimeoutMs: 5_000,
      healthPollMs: 50,
    });
    handles.push(handle);

    expect(handle.spawned).toBe(true);
    expect(handle.pid).toBeGreaterThan(0);

    // Confirm the child is actually serving via the same URL.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
  });

  it("kill() terminates the spawned child", async () => {
    const port = await pickPort();
    const handle = await startChildServer({
      name: "test",
      healthUrl: `http://127.0.0.1:${port}/health`,
      command: "node",
      args: [scriptPath, String(port)],
      cwd: workDir,
      startupTimeoutMs: 5_000,
      healthPollMs: 50,
    });
    const pid = handle.pid;
    expect(pid).not.toBeNull();

    await handle.kill();

    // Process should be gone — kill(0) raises ESRCH if so.
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("escalates to SIGKILL when SIGTERM is ignored past the grace period", async () => {
    const port = await pickPort();
    const handle = await startChildServer({
      name: "sticky",
      healthUrl: `http://127.0.0.1:${port}/health`,
      command: "node",
      args: [stickyScriptPath, String(port)],
      cwd: workDir,
      startupTimeoutMs: 5_000,
      healthPollMs: 50,
      killGracePeriodMs: 200,
    });
    const pid = handle.pid!;

    const t0 = Date.now();
    await handle.kill();
    const elapsed = Date.now() - t0;

    // Must have waited at least the grace period before SIGKILL.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("throws and cleans up if the child exits before becoming healthy", async () => {
    const port = await pickPort();
    await expect(startChildServer({
      name: "crash",
      healthUrl: `http://127.0.0.1:${port}/health`,
      command: "node",
      args: [crashScriptPath],
      cwd: workDir,
      startupTimeoutMs: 5_000,
      healthPollMs: 50,
    })).rejects.toThrow(/exited.*before becoming healthy/);
  });

  it("throws on health timeout and kills the child", async () => {
    // Spawn the script with port 0 — it'll listen on an ephemeral port that
    // doesn't match our healthUrl, so /health never resolves.
    const probeUrl = `http://127.0.0.1:${await pickPort()}/health`;

    await expect(startChildServer({
      name: "stuck",
      healthUrl: probeUrl,
      command: "node",
      args: [scriptPath, "0"],
      cwd: workDir,
      startupTimeoutMs: 400,
      healthPollMs: 50,
      killGracePeriodMs: 200,
    })).rejects.toThrow(/timed out/);
  });
});

afterAll(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
