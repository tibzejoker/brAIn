import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { NodeContext, Message } from "@brain/sdk";

// Temp file for test store
const TMP_DIR = path.join(__dirname, ".tmp-memory-test");
const STORE_PATH = path.join(TMP_DIR, "memory.json");

// Helper: build a minimal mock NodeContext
function mockCtx(messages: Message[]): NodeContext & {
  published: Array<{ topic: string; payload: unknown; metadata?: unknown }>;
  logs: Array<{ level: string; message: string }>;
  slept: boolean;
} {
  const published: Array<{ topic: string; payload: unknown; metadata?: unknown }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  let slept = false;

  return {
    messages,
    published,
    logs,
    get slept() { return slept; },
    readMessages: () => [],
    respond(content, metadata) {
      published.push({ topic: "memory.result", type: "text", criticality: 1, payload: { content }, metadata });
    },
    publish(topic, msg) {
      published.push({ topic, ...msg });
    },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sleep() { slept = true; },
    callLLM: vi.fn(),
    callTool: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    state: {},
    log(level, message) { logs.push({ level, message }); },
    node: {
      id: "test-node",
      type: "memory",
      name: "memory",
      description: "",
      tags: [],
      authority_level: 0,
      state: "active",
      priority: 3,
      subscriptions: [],
      transport: "process",
      position: { x: 0, y: 0 },
      created_at: Date.now(),
    },
    iteration: 1,
    wasPreempted: false,
    preemptionContext: undefined,
  };
}

function makeMsg(topic: string, content: string, from = "sender-123"): Message {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    from,
    topic,
    type: "text",
    criticality: 3,
    payload: { content },
    timestamp: Date.now(),
  };
}

function parseResult(ctx: ReturnType<typeof mockCtx>, index = 0): Record<string, unknown> {
  const pub = ctx.published[index];
  return JSON.parse((pub.payload as { content: string }).content) as Record<string, unknown>;
}

describe("memory handler", () => {
  // We need to dynamically import the handler because it uses resolveStorePath
  // which walks up from __dirname. We'll mock __dirname via the store file.
  let handler: (ctx: NodeContext) => Promise<void>;

  beforeEach(async () => {
    // Create temp dir and empty store
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, "{}");

    // Clear module cache to reload handler fresh
    // The handler resolves store path from __dirname walking up to pnpm-workspace.yaml
    // For tests, we pre-seed the store at the real data path
    const realStorePath = path.resolve(__dirname, "..", "data", "memory.json");
    // Save original if exists
    const backup = fs.existsSync(realStorePath) ? fs.readFileSync(realStorePath, "utf-8") : null;

    // Write test store with known data
    fs.writeFileSync(realStorePath, JSON.stringify({
      user_name: {
        key: "user_name",
        value: "Thibaut",
        tags: ["user"],
        created_at: 1000,
        updated_at: 1000,
        created_by: "test",
      },
      favorite_color: {
        key: "favorite_color",
        value: "blue",
        tags: ["user", "preference"],
        created_at: 2000,
        updated_at: 2000,
        created_by: "test",
      },
    }));

    // Dynamically import handler (source via vitest alias)
    const mod = await import("../nodes/memory/src/handler");
    handler = mod.handler;

    // Store backup for cleanup
    (globalThis as Record<string, unknown>).__memBackup = backup;
    (globalThis as Record<string, unknown>).__memPath = realStorePath;
  });

  afterEach(() => {
    // Restore original memory.json
    const backup = (globalThis as Record<string, unknown>).__memBackup as string | null;
    const realStorePath = (globalThis as Record<string, unknown>).__memPath as string;
    if (backup !== null) {
      fs.writeFileSync(realStorePath, backup);
    }
    // Clean temp
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  // === SLEEP ===

  it("sleeps when no messages", async () => {
    const ctx = mockCtx([]);
    await handler(ctx);
    expect(ctx.slept).toBe(true);
    expect(ctx.published).toHaveLength(0);
  });

  // === STORE ===

  it("stores a valid JSON entry", async () => {
    const ctx = mockCtx([
      makeMsg("memory.store", JSON.stringify({ key: "mood", value: "happy", tags: ["state"] })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.ok).toBe(true);
    expect(result.key).toBe("mood");
    expect(result.action).toBe("stored");
  });

  it("rejects non-JSON store payload", async () => {
    const ctx = mockCtx([
      makeMsg("memory.store", "just some free text"),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Invalid format");
    expect(result.hint).toContain("JSON");
    expect(result.received).toBeDefined();
  });

  it("rejects JSON store without key/value", async () => {
    const ctx = mockCtx([
      makeMsg("memory.store", JSON.stringify({ tags: ["orphan"] })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Missing required fields");
  });

  // === RECALL ===

  it("recalls an existing key", async () => {
    const ctx = mockCtx([
      makeMsg("memory.recall", JSON.stringify({ key: "user_name" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.found).toBe(true);
    expect(result.value).toBe("Thibaut");
  });

  it("returns not found for missing key", async () => {
    const ctx = mockCtx([
      makeMsg("memory.recall", JSON.stringify({ key: "nonexistent" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.found).toBe(false);
  });

  it("rejects non-JSON recall", async () => {
    const ctx = mockCtx([
      makeMsg("memory.recall", "just a string"),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Invalid format");
  });

  // === SEARCH ===

  it("searches by value content", async () => {
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "Thibaut" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBe(1);
    const results = result.results as Array<{ key: string }>;
    expect(results[0].key).toBe("user_name");
  });

  it("searches by tag", async () => {
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "preference" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBe(1);
    const results = result.results as Array<{ key: string }>;
    expect(results[0].key).toBe("favorite_color");
  });

  it("splits query into words and matches any", async () => {
    // "nom utilisateur" should match user_name because "user" in key (after _ split)
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "user name" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const results = result.results as Array<{ key: string }>;
    expect(results.some((r) => r.key === "user_name")).toBe(true);
  });

  it("matches key parts after underscore splitting", async () => {
    // "name" should match "user_name" because key is split on _
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "name" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const results = result.results as Array<{ key: string }>;
    expect(results.some((r) => r.key === "user_name")).toBe(true);
  });

  it("returns all entries as fallback when no match and store is small", async () => {
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "zzzznothing" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    // Should return all entries with a note
    expect(result.note).toContain("no match");
    expect(result.count).toBe(2);
  });

  it("ranks results by number of matching words", async () => {
    const ctx = mockCtx([
      makeMsg("memory.search", JSON.stringify({ query: "user blue" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    const results = result.results as Array<{ key: string }>;
    // favorite_color matches both "user" (tag) and "blue" (value) = 2 hits
    // user_name matches "user" (key+tag) = 1 hit
    expect(results.length).toBe(2);
    expect(results[0].key).toBe("favorite_color");
  });

  // === UPDATE ===

  it("updates an existing entry", async () => {
    const ctx = mockCtx([
      makeMsg("memory.update", JSON.stringify({ key: "user_name", value: "Thibaut L." })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("updated");
  });

  it("rejects update for nonexistent key", async () => {
    const ctx = mockCtx([
      makeMsg("memory.update", JSON.stringify({ key: "nope", value: "x" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Key not found");
  });

  // === DELETE ===

  it("deletes an existing entry", async () => {
    const ctx = mockCtx([
      makeMsg("memory.delete", JSON.stringify({ key: "favorite_color" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("deleted");
    expect(result.was).toBe("blue");
  });

  it("rejects delete for nonexistent key", async () => {
    const ctx = mockCtx([
      makeMsg("memory.delete", JSON.stringify({ key: "nope" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Key not found");
  });

  // === LIST ===

  it("lists all entries", async () => {
    const ctx = mockCtx([
      makeMsg("memory.list", JSON.stringify({})),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBe(2);
  });

  it("lists entries filtered by tag", async () => {
    const ctx = mockCtx([
      makeMsg("memory.list", JSON.stringify({ query: "preference" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBe(1);
    const entries = result.entries as Array<{ key: string }>;
    expect(entries[0].key).toBe("favorite_color");
  });

  // === UNKNOWN ACTION ===

  it("returns error for unknown action", async () => {
    const ctx = mockCtx([
      makeMsg("memory.foobar", JSON.stringify({ key: "x" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Unknown action");
    expect(result.available).toBeDefined();
  });

  // === PUBLISHES TO memory.result ===

  it("publishes all results to memory.result", async () => {
    const ctx = mockCtx([
      makeMsg("memory.store", JSON.stringify({ key: "a", value: "b" })),
      makeMsg("memory.recall", JSON.stringify({ key: "a" })),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(2);
    expect(ctx.published.every((p) => p.topic === "memory.result")).toBe(true);
  });
});
