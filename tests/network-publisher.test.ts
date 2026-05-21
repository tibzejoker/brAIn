import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  BusService,
  NetworkDirectory,
  startNetworkPublisher,
  type NetworkPublisherHandle,
} from "@brain/core";
import { type NodeInfo, NodeState, AuthorityLevel, type HubRef } from "@brain/sdk";

const HUB: HubRef = { hub_id: "hubA", hub_label: "A", http_url: "http://10.0.0.5:3000" };

function node(id: string): NodeInfo {
  return {
    id, type: "demo", name: id, description: "", tags: [],
    authority_level: AuthorityLevel.BASIC, state: NodeState.ACTIVE,
    priority: 0, subscriptions: [], transport: "process",
    position: { x: 0, y: 0 }, created_at: 1,
  };
}

describe("startNetworkPublisher", () => {
  let pub: NetworkPublisherHandle | null = null;
  let dir: NetworkDirectory | null = null;
  afterEach(() => { pub?.stop(); pub = null; dir?.detach(); dir = null; });

  it("publishes a snapshot a peer directory picks up, tagged with owner_hub", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, "peerB");
    dir.attach();

    let nodes = [node("n1")];
    pub = startNetworkPublisher({ bus, hub: HUB, snapshot: () => nodes });

    // publishNow() ran on start.
    expect(dir.mergedNodes().map((n) => n.id)).toEqual(["n1"]);
    expect(dir.mergedNodes()[0].owner_hub).toEqual(HUB);

    // Reflects the live snapshot source on the next publish.
    nodes = [node("n1"), node("n2")];
    pub.publishNow();
    expect(dir.mergedNodes().map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });

  it("republishes (debounced) when a change event fires", async () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, "peerB");
    dir.attach();
    const changes = new EventEmitter();

    let nodes: NodeInfo[] = [];
    pub = startNetworkPublisher({ bus, hub: HUB, snapshot: () => nodes, changes });
    expect(dir.mergedNodes()).toHaveLength(0);

    nodes = [node("x")];
    changes.emit("node:spawned", node("x"));
    await new Promise((r) => setTimeout(r, 160));
    expect(dir.mergedNodes().map((n) => n.id)).toEqual(["x"]);
  });

  it("sends a bye on stop so the peer drops the hub", () => {
    const bus = new BusService();
    dir = new NetworkDirectory(bus, "peerB");
    dir.attach();
    pub = startNetworkPublisher({ bus, hub: HUB, snapshot: () => [node("n1")] });
    expect(dir.hubs()).toHaveLength(1);

    pub.stop();
    pub = null;
    expect(dir.hubs()).toHaveLength(0);
  });
});
