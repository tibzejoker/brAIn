/**
 * Integration test — two NatsBusService instances share a real NATS
 * broker. Validates that publishing on one instance lands in the
 * mailbox of a subscriber registered on the other instance, with
 * trace propagation preserved.
 *
 * Skips automatically if `nats-server` isn't on PATH (CI without
 * the binary still passes).
 */
import { describe, it, expect } from "vitest";
import { NatsBusService } from "@brain/core";
import { setTimeout as wait } from "node:timers/promises";

// Shared broker provided by tests/_setup/nats-broker.ts (vitest
// globalSetup). Skips silently if it didn't come up — typically a
// fresh CI run before postinstall has fetched the binary.
const URL = process.env.BRAIN_TEST_NATS_URL;
const HAS_NATS = !!URL;

describe.skipIf(!HAS_NATS)("NatsBusService — cross-instance routing", () => {
  it("delivers a publish from instance A to a subscriber on instance B", async () => {
    const a = new NatsBusService({ url: URL!, prefix: "test1" });
    const b = new NatsBusService({ url: URL!, prefix: "test1" });
    await a.connect(); await b.connect();
    try {
      b.subscribe("recv", "ping");
      a.publish({ from: "sender", topic: "ping", type: "text", criticality: 1, payload: { content: "hello" } });
      // Round-trip through NATS is async; poll briefly.
      const deadline = Date.now() + 1500;
      let got = b.getUnreadMessages("recv");
      while (got.length === 0 && Date.now() < deadline) {
        await wait(30);
        got = b.getUnreadMessages("recv");
      }
      expect(got).toHaveLength(1);
      expect(got[0].topic).toBe("ping");
      expect(got[0].from).toBe("sender");
      expect((got[0].payload as { content: string }).content).toBe("hello");
    } finally {
      await a.close(); await b.close();
    }
  });

  it("does NOT deliver back to the publishing instance (anti-loop on origin)", async () => {
    const a = new NatsBusService({ url: URL!, prefix: "test2" });
    await a.connect();
    try {
      a.subscribe("self", "echo");
      // Publish from a *different* node id on the same instance — this
      // delivers locally (anti-loop is only by node id, not by origin).
      a.publish({ from: "other-node", topic: "echo", type: "text", criticality: 1, payload: { content: "x" } });
      // Local delivery is synchronous.
      expect(a.getUnreadMessages("self")).toHaveLength(1);
      // Wait a beat to give NATS round-trip a chance — the origin filter
      // should drop it on receive so we don't deliver twice.
      await wait(300);
      expect(a.getUnreadCount("self")).toBe(0);  // marked read on first call
      // Re-add a subscription to a fresh node and check no extra delivery.
      a.subscribe("witness", "echo");
      await wait(200);
      expect(a.getUnreadCount("witness")).toBe(0);
    } finally {
      await a.close();
    }
  });

  it("preserves trace_id across instances", async () => {
    const a = new NatsBusService({ url: URL!, prefix: "test3" });
    const b = new NatsBusService({ url: URL!, prefix: "test3" });
    await a.connect(); await b.connect();
    try {
      b.subscribe("recv", "step.*");
      const root = a.publish({ from: "a", topic: "step.one", type: "text", criticality: 1, payload: { content: "1" } });
      const deadline = Date.now() + 1500;
      let got = b.getUnreadMessages("recv");
      while (got.length === 0 && Date.now() < deadline) {
        await wait(30);
        got = b.getUnreadMessages("recv");
      }
      expect(got[0].trace_id).toBe(root.trace_id);
    } finally {
      await a.close(); await b.close();
    }
  });
});
