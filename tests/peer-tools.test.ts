/**
 * Peer-aware tool discovery.
 *
 * The consciousness invokes a tool by publishing on its topic — NATS
 * delivers that cross-machine regardless of where the node lives, so
 * invocation already worked for peer hubs. The only gap was DISCOVERY:
 * `ctx.tools.list()` walked the local InstanceRegistry only, so the LLM
 * never learned a peer node's topic/schema and never built a tool for it.
 *
 * These tests pin the fix: the tools facade merges `deps.peerNodes()`
 * (other machines' nodes, already tagged owner_hub) with the local
 * registry, de-duping by id (local wins).
 */
import { describe, it, expect } from "vitest";
import { BusService } from "@brain/core";
import { type NodeInfo, NodeState, AuthorityLevel } from "@brain/sdk";
import { buildNodeContext } from "../packages/core/src/runner/context-builder";

function node(id: string, topic: string): NodeInfo {
  return {
    id, type: "demo", name: id, description: "", tags: [],
    authority_level: AuthorityLevel.BASIC, state: NodeState.ACTIVE,
    priority: 0, transport: "process", position: { x: 0, y: 0 }, created_at: 1,
    subscriptions: [
      { topic, description: `do ${topic}`, inputSchema: { type: "object" }, internal: false },
    ],
  };
}

const log = {
  add: () => {}, info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
} as unknown as Parameters<typeof buildNodeContext>[0]["log"];

function ctxWith(local: NodeInfo[], peers: NodeInfo[]) {
  return buildNodeContext(
    { nodeInfo: node("brain", "chat.input"), state: {}, log, iteration: 0 },
    {
      bus: new BusService(),
      instanceRegistry: { list: () => local },
      peerNodes: () => peers,
    },
    [], new AbortController().signal, null,
  );
}

describe("ctx.tools.list() peer merge", () => {
  it("surfaces peer-hub nodes alongside local ones", () => {
    const ctx = ctxWith([node("local-1", "local.do")], [node("remote-1", "remote.do")]);
    const topics = ctx.tools.list().map((t) => t.topic).sort();
    expect(topics).toEqual(["local.do", "remote.do"]);
  });

  it("works with no peers (local only)", () => {
    const ctx = ctxWith([node("local-1", "local.do")], []);
    expect(ctx.tools.list().map((t) => t.topic)).toEqual(["local.do"]);
  });

  it("de-dupes by node id — local wins over a peer with the same id", () => {
    const ctx = ctxWith([node("dup", "local.version")], [node("dup", "peer.version")]);
    const tools = ctx.tools.list();
    expect(tools).toHaveLength(1);
    expect(tools[0].topic).toBe("local.version");
  });
});
