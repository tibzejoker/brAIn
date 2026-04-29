/**
 * NatsBusService unit tests.
 *
 * These tests run WITHOUT a real NATS broker — they exercise the
 * local-routing code path (which is identical to the in-memory bus)
 * to confirm the abstraction holds. Cross-instance routing requires
 * an actual NATS server and is covered by an integration test that
 * skips when nats-server isn't available.
 */
import { describe, it, expect } from "vitest";
import { NatsBusService } from "@brain/core";
import type { Message } from "@brain/sdk";

function basePublish(opts: Partial<Message> & { from: string; topic: string; criticality: number }): Parameters<NatsBusService["publish"]>[0] {
  return {
    type: "text", payload: { content: "x" },
    ...opts,
  };
}

describe("NatsBusService — local routing (no broker)", () => {
  it("delivers a message to a matching subscriber on the same instance", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "ping");
    bus.publish(basePublish({ from: "sender", topic: "ping", criticality: 1 }));
    const got = bus.getUnreadMessages("recv");
    expect(got).toHaveLength(1);
    expect(got[0].topic).toBe("ping");
    expect(got[0].from).toBe("sender");
    expect(got[0].trace_id).toBeDefined();
  });

  it("matches wildcards (alerts.* matches all depths)", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "alerts.*");
    bus.publish(basePublish({ from: "x", topic: "alerts.cpu.high", criticality: 5 }));
    bus.publish(basePublish({ from: "x", topic: "alerts.disk.full", criticality: 5 }));
    bus.publish(basePublish({ from: "x", topic: "metrics.cpu", criticality: 5 }));
    expect(bus.getUnreadMessages("recv").map((m) => m.topic).sort())
      .toEqual(["alerts.cpu.high", "alerts.disk.full"]);
  });

  it("anti-loop: a node never receives its own messages", () => {
    const bus = new NatsBusService();
    bus.subscribe("self", "echo");
    bus.publish(basePublish({ from: "self", topic: "echo", criticality: 1 }));
    expect(bus.getUnreadMessages("self")).toHaveLength(0);
  });

  it("filters by min_criticality on the subscription", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "alerts.*", { min_criticality: 5 });
    bus.publish(basePublish({ from: "x", topic: "alerts.low", criticality: 2 }));
    bus.publish(basePublish({ from: "x", topic: "alerts.high", criticality: 7 }));
    const got = bus.getUnreadMessages("recv");
    expect(got).toHaveLength(1);
    expect(got[0].topic).toBe("alerts.high");
  });

  it("emits per-node events the runner can listen to", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "ping");
    let count = 0;
    bus.on("message:recv", () => { count++; });
    bus.publish(basePublish({ from: "sender", topic: "ping", criticality: 1 }));
    bus.publish(basePublish({ from: "sender", topic: "ping", criticality: 1 }));
    expect(count).toBe(2);
  });

  it("preserves causal trace fields (auto trace_id, parent_id inheritance)", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "step.*");
    const root = bus.publish(basePublish({ from: "a", topic: "step.one", criticality: 1 }));
    expect(root.trace_id).toBeDefined();
    const child = bus.publish(basePublish({
      from: "b", topic: "step.two", criticality: 1, parent_id: root.id,
    }));
    expect(child.trace_id).toBe(root.trace_id);
    expect(bus.getTrace(root.trace_id!)).toHaveLength(2);
  });

  it("getMessageHistory respects topic filter", () => {
    const bus = new NatsBusService();
    bus.publish(basePublish({ from: "x", topic: "a.b", criticality: 1 }));
    bus.publish(basePublish({ from: "x", topic: "c.d", criticality: 1 }));
    bus.publish(basePublish({ from: "x", topic: "a.e", criticality: 1 }));
    expect(bus.getMessageHistory({ topic: "a.*" }).map((m) => m.topic).sort())
      .toEqual(["a.b", "a.e"]);
  });

  it("removeAllSubscriptions wipes a node's queue routing", () => {
    const bus = new NatsBusService();
    bus.subscribe("recv", "ping");
    bus.publish(basePublish({ from: "x", topic: "ping", criticality: 1 }));
    expect(bus.getUnreadCount("recv")).toBe(1);
    bus.removeAllSubscriptions("recv");
    bus.publish(basePublish({ from: "x", topic: "ping", criticality: 1 }));
    // Subscriptions are gone — unread count returns 0.
    expect(bus.getUnreadCount("recv")).toBe(0);
  });

  it("publish does not throw when NATS isn't connected (local-only mode)", () => {
    const bus = new NatsBusService();
    // Never called connect(). Local routing should still work — the NATS
    // bridge is opportunistic.
    expect(() => bus.publish(basePublish({ from: "x", topic: "y", criticality: 1 }))).not.toThrow();
  });
});
