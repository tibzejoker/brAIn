import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { NodeContext, Message } from "@brain/sdk";

// === Fake embeddings ===
// Returns a deterministic vector based on content hash so similar text gives similar vectors
const DIMS = 64;
function fakeEmbed(text: string): number[] {
  const vec = new Array(DIMS).fill(0) as number[];
  for (let i = 0; i < text.length; i++) {
    vec[i % DIMS] += text.charCodeAt(i) / 1000;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag > 0 ? vec.map((v) => v / mag) : vec;
}

// Mock fetch before importing handler
const originalFetch = globalThis.fetch;

function mockOllamaFetch(): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/api/embed")) {
      const body = JSON.parse(init?.body as string) as { input: string };
      const embedding = fakeEmbed(body.input);
      return new Response(JSON.stringify({ embeddings: [embedding] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Pass through anything else
    return originalFetch(input, init);
  }) as typeof fetch;
}

// === Mock NodeContext ===
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
      published.push({ topic: "memory-vector.result", type: "text", criticality: 1, payload: { content }, metadata });
    },
    publish(topic, msg) { published.push({ topic, ...msg }); },
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
      id: "test-vec-node",
      type: "memory-vector",
      name: "long-term-memory",
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

describe("memory-vector handler", () => {
  let handler: (ctx: NodeContext) => Promise<void>;
  let tmpDbDir: string;

  beforeEach(async () => {
    mockOllamaFetch();

    // Create a temp vector_db dir and point the handler to it
    tmpDbDir = path.join(__dirname, `.tmp-vector-test-${Date.now()}`);
    fs.mkdirSync(tmpDbDir, { recursive: true });

    // The handler uses resolveDbPath which walks up from __dirname to pnpm-workspace.yaml
    // It will resolve to data/vector_db in the project root
    // We need to use the real path — clean it up after
    const realDbPath = path.resolve(__dirname, "..", "data", "vector_db");
    const backupExists = fs.existsSync(realDbPath);

    // Save state for cleanup
    (globalThis as Record<string, unknown>).__vecBackup = backupExists;
    (globalThis as Record<string, unknown>).__vecDbPath = realDbPath;
    (globalThis as Record<string, unknown>).__tmpDbDir = tmpDbDir;

    // Remove existing DB so tests start fresh
    if (backupExists) {
      fs.renameSync(realDbPath, `${realDbPath}.bak-${Date.now()}`);
    }

    // Import handler fresh
    const mod = await import("../nodes/memory-vector/src/handler");
    handler = mod.handler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    // Clean temp dir
    const tmpDir = (globalThis as Record<string, unknown>).__tmpDbDir as string;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    // Restore real DB if it was backed up
    const realDbPath = (globalThis as Record<string, unknown>).__vecDbPath as string;
    const backups = fs.readdirSync(path.dirname(realDbPath))
      .filter((f) => f.startsWith("vector_db.bak-"))
      .map((f) => path.join(path.dirname(realDbPath), f));
    if (backups.length > 0) {
      // Remove test DB if created
      if (fs.existsSync(realDbPath)) {
        fs.rmSync(realDbPath, { recursive: true });
      }
      fs.renameSync(backups[0], realDbPath);
    } else if (fs.existsSync(realDbPath)) {
      // Remove test DB, no backup to restore
      fs.rmSync(realDbPath, { recursive: true });
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

  it("stores text and generates embedding", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "Thibaut is a developer", tags: ["user"] })),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].topic).toBe("memory-vector.result");

    const result = parseResult(ctx);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("stored");
    expect(result.dimensions).toBe(DIMS);

    // Verify embed was called
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/api/embed"),
      expect.anything(),
    );
  });

  it("rejects store without text", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ tags: ["test"] })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("store requires text");
  });

  it("rejects store with invalid JSON", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.store", "just free text here"),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toBeDefined();
  });

  // === SEARCH ===

  it("searches empty DB gracefully", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.search", JSON.stringify({ query: "developer" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.note).toContain("empty");
  });

  it("stores then searches and finds relevant results", async () => {
    // Store several documents
    const storeCtx1 = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "Thibaut is a software developer from France", tags: ["user"] })),
    ]);
    await handler(storeCtx1);
    expect(parseResult(storeCtx1).ok).toBe(true);

    const storeCtx2 = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "The weather in Paris is sunny today", tags: ["weather"] })),
    ]);
    await handler(storeCtx2);
    expect(parseResult(storeCtx2).ok).toBe(true);

    const storeCtx3 = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "JavaScript and TypeScript are programming languages", tags: ["tech"] })),
    ]);
    await handler(storeCtx3);
    expect(parseResult(storeCtx3).ok).toBe(true);

    // Search for something related to the user
    const searchCtx = mockCtx([
      makeMsg("memory-vector.search", JSON.stringify({ query: "Who is the developer?", limit: 3 })),
    ]);
    await handler(searchCtx);

    const result = parseResult(searchCtx);
    expect(result.count).toBeGreaterThan(0);

    const results = result.results as Array<{ text: string; tags: string; distance: number }>;
    expect(results.length).toBeGreaterThan(0);
    // Each result should have text, tags, source, distance
    expect(results[0].text).toBeDefined();
    expect(results[0].distance).toBeDefined();
  });

  it("respects search limit", async () => {
    // Store 3 docs
    for (const text of ["fact one", "fact two", "fact three"]) {
      const ctx = mockCtx([
        makeMsg("memory-vector.store", JSON.stringify({ text })),
      ]);
      await handler(ctx);
    }

    // Search with limit 1
    const searchCtx = mockCtx([
      makeMsg("memory-vector.search", JSON.stringify({ query: "fact", limit: 1 })),
    ]);
    await handler(searchCtx);

    const result = parseResult(searchCtx);
    expect(result.count).toBe(1);
  });

  it("rejects search without query", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.search", JSON.stringify({ limit: 5 })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("search requires query");
  });

  // === UNKNOWN ===

  it("returns error for unknown action", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.foobar", JSON.stringify({ text: "x" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toContain("Unknown action");
  });

  // === PUBLISH ===

  it("publishes results to memory-vector.result", async () => {
    const ctx = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "test doc" })),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].topic).toBe("memory-vector.result");
  });

  // === EMBEDDING FAILURE ===

  it("handles embedding failure gracefully", async () => {
    // Override mock to simulate Ollama down
    globalThis.fetch = vi.fn(async () => {
      return new Response("Service unavailable", { status: 503 });
    }) as typeof fetch;

    const ctx = mockCtx([
      makeMsg("memory-vector.store", JSON.stringify({ text: "should fail embedding" })),
    ]);
    await handler(ctx);

    const result = parseResult(ctx);
    expect(result.error).toBeDefined();
    expect(ctx.logs.some((l) => l.level === "error")).toBe(true);
  });
});
