/**
 * BrokerService unit tests — verify both modes:
 *
 * - **embedded**: spawns the bundled `nats-server`, picks a free
 *   port, exposes the URL, and tears down cleanly on stop().
 * - **external**: trusts a caller-provided URL and never spawns.
 *
 * The "broker actually accepts NATS connections" check is delegated
 * to nats-bus-integration.test.ts which uses a real client.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "node:net";
import { BrokerService } from "@brain/core";

const BUNDLED = resolve(__dirname, "..", "packages/core/bin/nats-server");
const HAS_BINARY = existsSync(BUNDLED);

function isPortOpen(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(t); sock.end(); resolve(true); });
    sock.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

describe("BrokerService — external mode", () => {
  it("returns the configured URL without spawning anything", async () => {
    const broker = new BrokerService({ externalUrl: "nats://example.invalid:4222" });
    const r = await broker.start();
    expect(r.mode).toBe("external");
    expect(r.url).toBe("nats://example.invalid:4222");
    expect(broker.getUrl()).toBe("nats://example.invalid:4222");
    expect(broker.isRunning()).toBe(true);
  });

  it("stop() is a no-op in external mode", async () => {
    const broker = new BrokerService({ externalUrl: "nats://example.invalid:4222" });
    await broker.start();
    await broker.stop();
    // External URL stays — there's nothing to "stop", we never owned it.
    expect(broker.getUrl()).toBe("nats://example.invalid:4222");
  });
});

describe.skipIf(!HAS_BINARY)("BrokerService — embedded mode", () => {
  it("spawns nats-server on a free port and exposes a routable URL", async () => {
    const broker = new BrokerService();
    const r = await broker.start();
    try {
      expect(r.mode).toBe("embedded");
      expect(r.url).toMatch(/^nats:\/\/127\.0\.0\.1:\d+$/);
      const port = Number(new URL(r.url).port);
      expect(await isPortOpen("127.0.0.1", port)).toBe(true);
    } finally {
      await broker.stop();
    }
  });

  it("stop() kills the child and frees the port", async () => {
    const broker = new BrokerService();
    const r = await broker.start();
    const port = Number(new URL(r.url).port);
    expect(await isPortOpen("127.0.0.1", port)).toBe(true);

    await broker.stop();
    expect(broker.isRunning()).toBe(false);
    expect(broker.getUrl()).toBeNull();
    expect(await isPortOpen("127.0.0.1", port)).toBe(false);
  });

  it("rejects double-start", async () => {
    const broker = new BrokerService();
    await broker.start();
    try {
      await expect(broker.start()).rejects.toThrow(/already started/);
    } finally {
      await broker.stop();
    }
  });

  it("stop() before start() is a no-op", async () => {
    const broker = new BrokerService();
    await expect(broker.stop()).resolves.toBeUndefined();
    expect(broker.isRunning()).toBe(false);
  });

  it("two brokers in parallel pick distinct ports", async () => {
    const a = new BrokerService();
    const b = new BrokerService();
    const [ra, rb] = await Promise.all([a.start(), b.start()]);
    try {
      expect(ra.url).not.toBe(rb.url);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("throws a helpful error when the binary is missing", async () => {
    const broker = new BrokerService({ binaryPath: "/no/such/path/nats-server" });
    await expect(broker.start()).rejects.toThrow(/binary not found/);
  });
});
