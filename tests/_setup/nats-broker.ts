/**
 * vitest globalSetup — spawns a single nats-server for the whole
 * test session and exposes its URL via `BRAIN_TEST_NATS_URL`.
 *
 * Tests that exercise NATS routing share this one broker; cross-test
 * pollution is avoided by giving each instance a unique `prefix`
 * (most of the suite already does that). Reusing a single broker
 * keeps the suite fast — spinning up nats-server takes ~80ms,
 * doing it per file would add noticeable overhead.
 *
 * Falls back to a no-op when the bundled binary isn't present
 * (postinstall failed, CI without network on first run, …) — the
 * tests that need a broker self-skip via the existing
 * `HAS_NATS`/`describe.skipIf` guards.
 */
import { BrokerService } from "@brain/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLED_BINARY = resolve(__dirname, "..", "..", "packages", "core", "bin", "nats-server");

let broker: BrokerService | null = null;

export async function setup(): Promise<void> {
  if (process.env.BRAIN_TEST_NATS_URL) {
    // Caller is providing their own broker — just trust it.
    return;
  }
  if (!existsSync(BUNDLED_BINARY)) {
    process.stderr.write("[test-setup] bundled nats-server missing — NATS-dependent tests will skip\n");
    return;
  }
  broker = new BrokerService({ binaryPath: BUNDLED_BINARY });
  const r = await broker.start();
  process.env.BRAIN_TEST_NATS_URL = r.url;
  process.stderr.write(`[test-setup] NATS up on ${r.url}\n`);
}

export async function teardown(): Promise<void> {
  if (broker) {
    await broker.stop();
    broker = null;
  }
}
