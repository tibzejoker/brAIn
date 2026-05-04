/**
 * Supervises the NATS broker the framework uses as its bus.
 *
 * Two modes, picked at construction:
 *
 *   - **embedded** — spawn the bundled `nats-server` Go binary on a
 *     free localhost port. The default for single-host setups: nothing
 *     for the user to install or run.
 *   - **external** — record an existing URL (BRAIN_NATS_URL) and don't
 *     spawn anything. Used when joining a shared broker on another
 *     host or pointing at infra-managed NATS.
 *
 * In both cases callers ask `getUrl()` to wire a `NatsBusService`.
 *
 * Crash semantics: if the embedded broker exits unexpectedly we log
 * a warn and clear our handle. We do **not** auto-restart in v1 — if
 * NATS dies, the bus is gone and so is most of the framework's
 * value, so we'd rather a process supervisor (pm2, systemd, docker)
 * notice and restart the API as a whole.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connect as netConnect, createServer, type AddressInfo } from "node:net";
import { resolve as resolvePath, dirname } from "node:path";
import { logger } from "../logger";

/**
 * Tiny on-disk pref for the broker bind address. Sits alongside the
 * SQLite DB so it travels with the data dir. The dashboard's
 * "Open to network" toggle writes here; BrokerService reads it on
 * boot. BRAIN_NATS_URL still wins — env beats config.
 */
export interface BrokerPrefs {
  /** "127.0.0.1" (loopback, default) or "0.0.0.0" (LAN-routable). */
  bindAddress: string;
}

export function readBrokerPrefs(prefsPath: string): BrokerPrefs {
  try {
    if (!existsSync(prefsPath)) return { bindAddress: "127.0.0.1" };
    const raw = JSON.parse(readFileSync(prefsPath, "utf-8")) as Partial<BrokerPrefs>;
    const bind = raw.bindAddress;
    if (bind !== "127.0.0.1" && bind !== "0.0.0.0") return { bindAddress: "127.0.0.1" };
    return { bindAddress: bind };
  } catch (err) {
    logger.warn({ err, prefsPath }, "broker prefs unreadable, falling back to loopback");
    return { bindAddress: "127.0.0.1" };
  }
}

export function writeBrokerPrefs(prefsPath: string, prefs: BrokerPrefs): void {
  mkdirSync(dirname(prefsPath), { recursive: true });
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), "utf-8");
}

export interface BrokerOptions {
  /**
   * If set, the service runs in *external mode* — no child spawned,
   * `getUrl()` returns this value as-is. Set this when the user
   * provides BRAIN_NATS_URL.
   */
  externalUrl?: string;
  /** Override the embedded binary path. Defaults to the postinstall location. */
  binaryPath?: string;
  /** Bind address. Default `127.0.0.1`. */
  host?: string;
  /** Specific port. Default: a free one picked from the OS. */
  port?: number;
  /** SIGTERM grace before SIGKILL on stop(). Default 3000ms. */
  killGraceMs?: number;
  /** Wait for listening before resolving start(). Default 5000ms. */
  startTimeoutMs?: number;
}

export type BrokerMode = "embedded" | "external";

export class BrokerService {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private readonly mode: BrokerMode;
  private cleanupRegistered = false;

  constructor(private readonly opts: BrokerOptions = {}) {
    this.mode = opts.externalUrl ? "external" : "embedded";
    if (opts.externalUrl) this.url = opts.externalUrl;
  }

  /**
   * Process-level safety net so the child dies even if NestJS's
   * graceful shutdown doesn't fire (uncaught exceptions, hot-reload
   * in `nest start --watch`, parent killed with SIGKILL upstream of
   * us, …). Registered once per BrokerService instance the first
   * time we successfully spawn a child.
   */
  private registerProcessCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    const killChildSync = (): void => {
      const c = this.child;
      if (!c || c.killed) return;
      try { c.kill("SIGTERM"); } catch { /* noop */ }
    };
    process.on("exit", killChildSync);
    process.on("SIGINT", () => { killChildSync(); process.exit(130); });
    process.on("SIGTERM", () => { killChildSync(); process.exit(143); });
    process.on("uncaughtException", (err) => {
      logger.error({ err }, "uncaught — killing broker before exit");
      killChildSync();
      process.exit(1);
    });
  }

  async start(): Promise<{ url: string; mode: BrokerMode }> {
    if (this.mode === "external") {
      const url = this.url;
      if (!url) throw new Error("external broker mode without url (impossible)");
      logger.info({ url }, "broker: external NATS");
      return { url, mode: "external" };
    }

    if (this.child) throw new Error("broker already started");

    const binaryPath = this.opts.binaryPath ?? this.resolveBinaryPath();
    if (!existsSync(binaryPath)) {
      throw new Error(
        `nats-server binary not found at ${binaryPath}. `
        + "Run `node scripts/install-nats.mjs` (or `pnpm install` to re-trigger postinstall) "
        + "or set BRAIN_NATS_URL to an external broker.",
      );
    }

    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port ?? await pickFreePort(host);

    const args = [
      "--addr", host,
      "--port", String(port),
    ];

    logger.info({ binaryPath, host, port }, "broker: spawning embedded NATS");
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    child.once("exit", (code, signal) => {
      // null code + signal = killed by us (stop()). Anything else is unexpected.
      const expected = code === 0 && (signal === "SIGTERM" || signal === null);
      if (!expected) {
        logger.error({ code, signal }, "nats-server exited unexpectedly — bus is now broken");
      }
      this.child = null;
      this.url = null;
    });
    child.on("error", (err) => {
      logger.error({ err }, "nats-server child error");
    });
    // nats-server writes its INF/DBG/ERR logs to stderr — sniff the
    // level marker so genuine errors stay loud while normal startup
    // chatter goes to debug.
    const routeLog = (txt: string): void => {
      if (!txt) return;
      if (txt.includes("[ERR]") || txt.includes("[FTL]")) {
        logger.error({ src: "nats-server" }, txt);
      } else if (txt.includes("[WRN]")) {
        logger.warn({ src: "nats-server" }, txt);
      } else {
        logger.debug({ src: "nats-server" }, txt);
      }
    };
    child.stdout.on("data", (data) => routeLog(data.toString().trim()));
    child.stderr.on("data", (data) => routeLog(data.toString().trim()));

    await waitForListening(host, port, this.opts.startTimeoutMs ?? 5000);
    this.url = `nats://${host}:${port}`;
    logger.info({ url: this.url, pid: child.pid }, "broker: embedded NATS ready");
    this.registerProcessCleanup();
    return { url: this.url, mode: "embedded" };
  }

  async stop(): Promise<void> {
    if (this.mode === "external") return;
    const child = this.child;
    if (!child) return;
    const grace = this.opts.killGraceMs ?? 3000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("nats-server didn't exit on SIGTERM — sending SIGKILL");
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, grace);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.kill("SIGTERM"); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.child = null;
    this.url = null;
  }

  getUrl(): string | null { return this.url; }
  getMode(): BrokerMode { return this.mode; }
  isRunning(): boolean { return this.mode === "external" || this.child !== null; }

  /** Resolve the binary postinstall placed at packages/core/bin/. */
  private resolveBinaryPath(): string {
    const ext = process.platform === "win32" ? ".exe" : "";
    // dist/broker/broker.service.js → ../../bin/nats-server
    return resolvePath(dirname(__filename), "..", "..", "bin", `nats-server${ext}`);
  }
}

function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address() as AddressInfo | null;
      if (!addr) {
        srv.close();
        reject(new Error("could not pick free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForListening(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) return;
    await sleep(100);
  }
  throw new Error(`nats-server didn't accept connections at ${host}:${port} within ${timeoutMs}ms`);
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    sock.once("connect", () => { sock.end(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
