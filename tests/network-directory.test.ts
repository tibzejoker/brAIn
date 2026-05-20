import { describe, it, expect, afterEach } from "vitest";
import {
  BusService,
  NetworkDirectory,
  NETWORK_SNAPSHOT_TOPIC,
  NETWORK_BYE_TOPIC,
  type NetworkSnapshot,
} from "@brain/core";
import { type NodeInfo, NodeState, AuthorityLevel } from "@brain/sdk";

const SELF = "self-hub";

function node(id: string): NodeInfo {
  return {
    id,
    type: "demo",
    name: id,
    description: "",
    tags: [],
    authority_level: AuthorityLevel.BASIC,
    state: NodeState.ACTIVE,
    priority: 0,
    subscriptions: [],
    transport: "process",
    position: { x: 0, y: 0 },
    created_at: 1,
  };
}

function publishSnapshot(
  bus: BusService,
  hubId: string,
  nodes: NodeInfo[],
  opts: { httpUrl?: string; ts?: number } = {},
): void {
  const snap: NetworkSnapshot = {
    hub: { hub_id: hubId, hub_label: hubId.toUpperCase(), http_url: opts.httpUrl },
    nodes,
    ts: opts.ts ?? Date.now(),
  };
  bus.publish({
    from: `agent:${hubId}`,
    topic: NETWORK_SNAPSHOT_TOPIC,
    type: "text",
    criticality: 0,
    payload: { content: JSON.stringify(snap) },
  });
}

describe("NetworkDirectory", () => {
  let dir: NetworkDirectory | null = null;
  afterEach(() => { dir?.detach(); dir = null; });

  it("tracks a peer hub and stamps owner_hub on merged nodes", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, SELF);
    dir.attach();

    publishSnapshot(bus, "peerA", [node("n1"), node("n2")], { httpUrl: "http://10.0.0.5:3000" });

    expect(dir.hubs().map((h) => h.hub_id)).toEqual(["peerA"]);
    const merged = dir.mergedNodes();
    expect(merged).toHaveLength(2);
    expect(merged[0].owner_hub).toEqual({
      hub_id: "peerA",
      hub_label: "PEERA",
      http_url: "http://10.0.0.5:3000",
    });
  });

  it("ignores snapshots from its own hub id", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, SELF);
    dir.attach();

    publishSnapshot(bus, SELF, [node("mine")]);

    expect(dir.hubs()).toHaveLength(0);
    expect(dir.mergedNodes()).toHaveLength(0);
  });

  it("emits hub:added once, hub:snapshot on every refresh", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, SELF);
    let added = 0; let snaps = 0;
    dir.on("hub:added", () => added++);
    dir.on("hub:snapshot", () => snaps++);
    dir.attach();

    publishSnapshot(bus, "peerB", [node("a")]);
    publishSnapshot(bus, "peerB", [node("a"), node("b")]);

    expect(added).toBe(1);
    expect(snaps).toBe(2);
    expect(dir.mergedNodes()).toHaveLength(2);
  });

  it("drops a hub immediately on bye", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, SELF);
    let expired = 0;
    dir.on("hub:expired", () => expired++);
    dir.attach();

    publishSnapshot(bus, "peerC", [node("x")]);
    expect(dir.hubs()).toHaveLength(1);

    bus.publish({
      from: "agent:peerC",
      topic: NETWORK_BYE_TOPIC,
      type: "text",
      criticality: 0,
      payload: { content: JSON.stringify({ hub_id: "peerC", ts: Date.now() }) },
    });

    expect(expired).toBe(1);
    expect(dir.hubs()).toHaveLength(0);
  });

  it("prunes hubs whose last snapshot is older than ttl", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, SELF, { ttlMs: 1_000 });
    dir.attach();

    publishSnapshot(bus, "stale", [node("z")], { ts: Date.now() - 5_000 });

    // Accessor runs the sweep — stale entry is gone.
    expect(dir.hubs()).toHaveLength(0);
    expect(dir.mergedNodes()).toHaveLength(0);
  });
});
