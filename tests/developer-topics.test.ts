import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrainService } from "@brain/core";
import type { Message } from "@brain/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * End-to-end of the new developer-node topics that don't require a code-
 * authoring CLI to be installed (workspaces.list, files.tree, cli.list).
 *
 * The auto-spawn path on `types.registered` and the actual `dev.request` /
 * `dev.improve` flows do require a CLI and are exercised in
 * `developer.test.ts` (which still skips when claude is missing).
 */
describe("developer node — query topics", () => {
  let brain: BrainService;
  let tmpDynamic: string;

  beforeAll(async () => {
    brain = new BrainService(":memory:");
    // Bootstrap with the sister repo so `developer` is registered.
    const essentialsNodes = path.resolve(
      __dirname,
      "../../storeprojects/brAIn-essentials/nodes",
    );
    const brAInNodes = path.resolve(__dirname, "../nodes");
    brain.bootstrap([brAInNodes, essentialsNodes]);

    // Stage a fake authored workspace so `dev.workspaces.list` has
    // something to scan. We layer it under brAIn/nodes/_dynamic — that's
    // where `resolveMonorepoRoot()` ends up walking up from __dirname of
    // the dist'd handler.
    tmpDynamic = path.join(brAInNodes, "_dynamic", "dev-aaa11111");
    if (!fs.existsSync(tmpDynamic)) {
      fs.mkdirSync(tmpDynamic, { recursive: true });
    }
    fs.writeFileSync(
      path.join(tmpDynamic, "config.json"),
      JSON.stringify({
        name: "fake-fixture-only",
        description: "fixture for developer-topics test",
        tags: [],
        default_authority: 0,
        default_priority: 1,
        default_subscriptions: [],
        default_publishes: [],
        supports_transport: ["process"],
      }),
    );
    fs.mkdirSync(path.join(tmpDynamic, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDynamic, "src", "handler.ts"), "// fixture\n");
  }, 30000);

  afterAll(() => {
    brain.killAll();
    if (tmpDynamic && fs.existsSync(tmpDynamic)) {
      fs.rmSync(tmpDynamic, { recursive: true, force: true });
    }
  });

  function collectFor(topic: string, predicate?: (m: Message) => boolean): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        brain.bus.off("message:published", listener);
        reject(new Error(`timed out waiting for ${topic}`));
      }, 5000);
      const listener = (msg: Message): void => {
        if (msg.topic !== topic) return;
        if (predicate && !predicate(msg)) return;
        clearTimeout(timer);
        brain.bus.off("message:published", listener);
        resolve(msg);
      };
      brain.bus.on("message:published", listener);
    });
  }

  async function spawnDev(): Promise<string> {
    const node = await brain.spawnNode({
      type: "developer",
      name: "test-dev",
      subscriptions: [
        // Re-declare default subs so the test doesn't rely on the
        // type's defaults (defaults can drift; this is documented).
        { topic: "dev.workspaces.list", description: "list" },
        { topic: "dev.files.tree", description: "tree" },
        { topic: "dev.cli.list", description: "cli" },
      ],
    });
    return node.id;
  }

  it("answers dev.workspaces.list with a snapshot of nodes/_dynamic/", async () => {
    const id = await spawnDev();
    const wait = collectFor("dev.workspaces");
    brain.bus.publish({
      from: "system.test",
      topic: "dev.workspaces.list",
      type: "text",
      criticality: 3,
      payload: { content: "" },
    });
    const reply = await wait;
    const meta = reply.metadata as { items?: Array<{ slug: string; type_name: string | null }> } | undefined;
    expect(meta).toBeDefined();
    expect(Array.isArray(meta?.items)).toBe(true);
    const fixture = meta!.items!.find((w) => w.slug === "dev-aaa11111");
    expect(fixture).toBeDefined();
    expect(fixture?.type_name).toBe("fake-fixture-only");
    brain.killNode(id);
  }, 15000);

  it("answers dev.files.tree with the workspace tree", async () => {
    const id = await spawnDev();
    const wait = collectFor("dev.files");
    brain.bus.publish({
      from: "system.test",
      topic: "dev.files.tree",
      type: "text",
      criticality: 3,
      payload: { content: JSON.stringify({ slug: "dev-aaa11111" }) },
    });
    const reply = await wait;
    const meta = reply.metadata as { slug?: string; tree?: Array<{ name: string; is_dir: boolean }> } | undefined;
    expect(meta?.slug).toBe("dev-aaa11111");
    expect(Array.isArray(meta?.tree)).toBe(true);
    const names = meta!.tree!.map((n) => n.name).sort();
    expect(names).toContain("config.json");
    expect(names).toContain("src");
    brain.killNode(id);
  }, 15000);

  it("answers dev.files.tree with an error for an unknown slug", async () => {
    const id = await spawnDev();
    const wait = collectFor("dev.files");
    brain.bus.publish({
      from: "system.test",
      topic: "dev.files.tree",
      type: "text",
      criticality: 3,
      payload: { content: JSON.stringify({ slug: "dev-zzzzzzzz" }) },
    });
    const reply = await wait;
    const meta = reply.metadata as { error?: string } | undefined;
    expect(meta?.error).toBe("not found");
    brain.killNode(id);
  }, 15000);

  it("answers dev.cli.list with the available CLIs", async () => {
    const id = await spawnDev();
    const wait = collectFor("dev.cli.available");
    brain.bus.publish({
      from: "system.test",
      topic: "dev.cli.list",
      type: "text",
      criticality: 3,
      payload: { content: "" },
    });
    const reply = await wait;
    const meta = reply.metadata as { clis?: string[]; default?: string } | undefined;
    expect(Array.isArray(meta?.clis)).toBe(true);
    expect(typeof meta?.default).toBe("string");
    brain.killNode(id);
  }, 15000);
});
