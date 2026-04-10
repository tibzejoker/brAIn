import { describe, it, expect } from "vitest";
import { BusService, matchTopic, Mailbox } from "@brain/core";

describe("matchTopic", () => {
  it("matches exact topics", () => {
    expect(matchTopic("alerts.audio", "alerts.audio")).toBe(true);
    expect(matchTopic("alerts.audio", "alerts.video")).toBe(false);
  });

  it("matches wildcard suffix", () => {
    expect(matchTopic("alerts.*", "alerts.audio")).toBe(true);
    expect(matchTopic("alerts.*", "alerts.audio.urgent")).toBe(true);
    expect(matchTopic("alerts.*", "other.topic")).toBe(false);
  });

  it("matches catch-all", () => {
    expect(matchTopic("*", "anything")).toBe(true);
    expect(matchTopic("*", "deeply.nested.topic")).toBe(true);
  });
});

describe("Mailbox", () => {
  it("stores and reads messages", () => {
    const mb = new Mailbox({ max_size: 10, retention: "latest" });
    mb.push({ id: "1", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "hi" }, timestamp: 1 });
    mb.push({ id: "2", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "there" }, timestamp: 2 });

    expect(mb.size).toBe(2);
    expect(mb.hasUnread()).toBe(true);

    const unread = mb.readUnread();
    expect(unread).toHaveLength(2);
    expect(mb.hasUnread()).toBe(false);
  });

  it("evicts oldest on overflow with latest retention", () => {
    const mb = new Mailbox({ max_size: 2, retention: "latest" });
    mb.push({ id: "1", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "1" }, timestamp: 1 });
    mb.push({ id: "2", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "2" }, timestamp: 2 });
    mb.push({ id: "3", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "3" }, timestamp: 3 });

    expect(mb.size).toBe(2);
    const all = mb.readAll();
    expect(all.map((m) => m.id)).toEqual(["2", "3"]);
  });

  it("evicts lowest priority on overflow with lowest_priority retention", () => {
    const mb = new Mailbox({ max_size: 2, retention: "lowest_priority" });
    mb.push({ id: "1", from: "a", topic: "t", type: "text", criticality: 5, payload: { content: "high" }, timestamp: 1 });
    mb.push({ id: "2", from: "a", topic: "t", type: "text", criticality: 1, payload: { content: "low" }, timestamp: 2 });
    mb.push({ id: "3", from: "a", topic: "t", type: "text", criticality: 3, payload: { content: "mid" }, timestamp: 3 });

    expect(mb.size).toBe(2);
    const all = mb.readAll();
    expect(all.map((m) => m.id)).toEqual(["1", "3"]);
  });

  it("supports peek without marking as read", () => {
    const mb = new Mailbox({ max_size: 10, retention: "latest" });
    mb.push({ id: "1", from: "a", topic: "t", type: "text", criticality: 0, payload: { content: "x" }, timestamp: 1 });

    const peeked = mb.read({ mode: "unread", peek: true });
    expect(peeked).toHaveLength(1);
    expect(mb.hasUnread()).toBe(true);

    const read = mb.readUnread();
    expect(read).toHaveLength(1);
    expect(mb.hasUnread()).toBe(false);
  });
});

describe("BusService", () => {
  it("publishes and routes messages to subscribers", () => {
    const bus = new BusService();
    bus.subscribe("node-1", "alerts.*");

    bus.publish({ from: "node-2", topic: "alerts.fire", type: "text", criticality: 5, payload: { content: "fire!" } });

    const msgs = bus.getUnreadMessages("node-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].topic).toBe("alerts.fire");
  });

  it("does not route messages back to sender (anti-loop)", () => {
    const bus = new BusService();
    bus.subscribe("node-1", "echo.*");

    bus.publish({ from: "node-1", topic: "echo.output", type: "text", criticality: 0, payload: { content: "self" } });

    const msgs = bus.getUnreadMessages("node-1");
    expect(msgs).toHaveLength(0);
  });

  it("filters by criticality on subscription", () => {
    const bus = new BusService();
    bus.subscribe("node-1", "alerts.*", { min_criticality: 5 });

    bus.publish({ from: "node-2", topic: "alerts.low", type: "text", criticality: 2, payload: { content: "low" } });
    bus.publish({ from: "node-2", topic: "alerts.high", type: "text", criticality: 7, payload: { content: "high" } });

    const msgs = bus.getUnreadMessages("node-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].topic).toBe("alerts.high");
  });

  it("maintains message history", () => {
    const bus = new BusService();
    bus.publish({ from: "a", topic: "x", type: "text", criticality: 0, payload: { content: "1" } });
    bus.publish({ from: "b", topic: "y", type: "text", criticality: 3, payload: { content: "2" } });

    const history = bus.getMessageHistory({ last: 10 });
    expect(history).toHaveLength(2);
  });

  it("unsubscribes by topic", () => {
    const bus = new BusService();
    bus.subscribe("node-1", "time.*");
    bus.unsubscribe("node-1", "time.*");

    bus.publish({ from: "node-2", topic: "time.tick", type: "text", criticality: 0, payload: { content: "tick" } });

    const msgs = bus.getUnreadMessages("node-1");
    expect(msgs).toHaveLength(0);
  });
});
