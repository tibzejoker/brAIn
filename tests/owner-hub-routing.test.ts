/**
 * Command-bus routing by owner_hub.
 *
 * A lifecycle command (kill/stop/start) for a node we neither host locally
 * nor spawned remotely — i.e. a peer-owned node discovered via the network
 * snapshot — must still route to the owning hub's `brain.agents.<hub>.*`
 * command channel, by node id. This is what makes control location-
 * transparent ("any node, anywhere, by id").
 */
import { describe, it, expect } from "vitest";
import type { Message } from "@brain/sdk";
import { killNode, type LifecycleDeps } from "../packages/core/src/brain-lifecycle";
import { dispatchRemoteAction } from "../packages/core/src/brain-remote";

function depsWith(published: Message[], owner: (id: string) => string | undefined): LifecycleDeps {
  return {
    bus: { publish: (m: Message) => { published.push(m); return m; } },
    remoteNodes: new Map<string, string>(),         // we did NOT spawn it
    ownerHubOf: owner,
    instanceRegistry: { get: () => undefined, remove: () => {}, updateState: () => {} },
  } as unknown as LifecycleDeps;
}

describe("lifecycle routing by owner_hub", () => {
  it("kills a peer-owned node by id on its hub's command channel", () => {
    const published: Message[] = [];
    const deps = depsWith(published, (id) => (id === "peer-node-1" ? "hub-B" : undefined));

    const ok = killNode(deps, "peer-node-1", undefined, "cleanup");

    expect(ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe("brain.agents.hub-B.kill");
    expect((published[0].metadata as { node_id?: string }).node_id).toBe("peer-node-1");
  });

  it("stops a peer-owned node by id on its hub's command channel", () => {
    const published: Message[] = [];
    const deps = depsWith(published, () => "hub-C");

    const ok = dispatchRemoteAction(deps, "peer-node-2", "stop");

    expect(ok).toBe(true);
    expect(published[0].topic).toBe("brain.agents.hub-C.stop");
  });

  it("returns false for an unknown node (not local, not remote, no owner)", () => {
    const published: Message[] = [];
    const deps = depsWith(published, () => undefined);

    // dispatchRemoteAction can't route → false (caller falls back to local).
    expect(dispatchRemoteAction(deps, "ghost", "start")).toBe(false);
    expect(published).toHaveLength(0);
  });
});
