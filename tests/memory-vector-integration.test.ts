/**
 * E2E integration test for memory-vector node.
 *
 * Uses REAL Ollama embeddings (qwen3-embedding:0.6b) and a real LanceDB
 * to validate the full pipeline: store → embed → semantic search → ranking.
 *
 * Requires Ollama running locally with the embedding model pulled.
 * Skipped automatically if Ollama is not available.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { NodeContext, Message } from "@brain/sdk";

// === Check Ollama availability before running ===
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-embedding:0.6b", input: "ping" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// === Mock NodeContext ===
function mockCtx(messages: Message[]): NodeContext & {
  published: Array<{ topic: string; payload: unknown; metadata?: unknown }>;
  logs: Array<{ level: string; message: string }>;
} {
  const published: Array<{ topic: string; payload: unknown; metadata?: unknown }> = [];
  const logs: Array<{ level: string; message: string }> = [];

  return {
    messages,
    published,
    logs,
    readMessages: () => [],
    publish(topic, msg) { published.push({ topic, ...msg }); },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sleep: vi.fn(),
    callLLM: vi.fn(),
    callTool: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    state: {},
    log(level, message) { logs.push({ level, message }); },
    node: {
      id: "e2e-test",
      type: "memory-vector",
      name: "e2e-memory",
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

function makeMsg(topic: string, content: string): Message {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    from: "test-sender",
    topic,
    type: "text",
    criticality: 3,
    payload: { content },
    timestamp: Date.now(),
  };
}

function parseResult(ctx: ReturnType<typeof mockCtx>, index = 0): Record<string, unknown> {
  return JSON.parse((ctx.published[index].payload as { content: string }).content) as Record<string, unknown>;
}

type SearchResult = { text: string; tags: string; source: string; distance: number };

describe("memory-vector e2e with real embeddings", async () => {
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    it.skip("Ollama not available — skipping e2e", () => {});
    return;
  }

  let handler: (ctx: NodeContext) => Promise<void>;
  let realDbPath: string;
  let backupPath: string | null = null;

  const CORPUS = [
    { text: "Thibaut is a French software developer who builds the brAIn project using TypeScript", tags: ["user", "identity"] },
    { text: "The brAIn project is a network of autonomous AI nodes communicating via a pub/sub message bus", tags: ["project", "architecture"] },
    { text: "Paris is the capital city of France, known for the Eiffel Tower and its gastronomy", tags: ["geography", "france"] },
    { text: "JavaScript closures capture variables from their surrounding lexical scope at function creation", tags: ["programming", "javascript"] },
    { text: "Redis is an in-memory data store used for caching, pub/sub messaging, and session storage", tags: ["infrastructure", "database"] },
    { text: "The memory node stores key-value pairs with tags for fast retrieval and search", tags: ["project", "memory"] },
    { text: "Machine learning models use embeddings to represent text as dense numerical vectors", tags: ["ai", "embeddings"] },
    { text: "React components use hooks like useState and useEffect for managing component lifecycle and state", tags: ["programming", "react"] },
    { text: "PostgreSQL is a relational database that supports JSON columns and full text search", tags: ["infrastructure", "database"] },
    { text: "The cat sat on the mat and watched birds through the window all afternoon", tags: ["random", "animals"] },
  ];

  beforeAll(async () => {
    realDbPath = path.resolve(__dirname, "..", "data", "vector_db");
    if (fs.existsSync(realDbPath)) {
      backupPath = `${realDbPath}.e2e-bak-${Date.now()}`;
      fs.renameSync(realDbPath, backupPath);
    }

    const mod = await import("../nodes/memory-vector/src/handler");
    handler = mod.handler;

    // Store all corpus documents
    for (const doc of CORPUS) {
      const ctx = mockCtx([
        makeMsg("memory-vector.store", JSON.stringify(doc)),
      ]);
      await handler(ctx);
      const result = parseResult(ctx);
      if (!result.ok) throw new Error(`Failed to store: ${JSON.stringify(result)}`);
    }
  });

  afterAll(() => {
    if (fs.existsSync(realDbPath)) {
      fs.rmSync(realDbPath, { recursive: true });
    }
    if (backupPath && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, realDbPath);
    }
  });

  async function search(query: string, limit = 5): Promise<SearchResult[]> {
    const ctx = mockCtx([
      makeMsg("memory-vector.search", JSON.stringify({ query, limit })),
    ]);
    await handler(ctx);
    const result = parseResult(ctx);
    return result.results as SearchResult[];
  }

  // --- Semantic relevance: top result matches the expected domain ---

  it("finds Thibaut when asking about the developer", async () => {
    const results = await search("Who is the developer of the project?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("Thibaut");
  });

  it("finds Paris when asking about European landmarks", async () => {
    const results = await search("Famous European city with a tower monument");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("Paris");
  });

  it("finds brAIn architecture when asking about the message system", async () => {
    const results = await search("How do the nodes communicate with each other?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("pub/sub");
  });

  it("finds the embeddings doc when asking about vector representations", async () => {
    const results = await search("How is text converted to numerical representations?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("embeddings");
  });

  it("finds the cat when asking about animals", async () => {
    const results = await search("What was the animal doing at home?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("cat");
  });

  // --- Cross-language: French query should still match English docs ---

  it("finds Thibaut with a French query", async () => {
    const results = await search("Qui est le développeur du projet ?");
    expect(results.length).toBeGreaterThan(0);
    // Thibaut doc or brAIn doc should be in top 3
    const top3 = results.slice(0, 3).map((r) => r.text);
    expect(top3.some((t) => t.includes("Thibaut") || t.includes("brAIn"))).toBe(true);
  });

  it("finds Paris with a French query", async () => {
    const results = await search("Quelle est la capitale de la France ?");
    expect(results.length).toBeGreaterThan(0);
    const top3 = results.slice(0, 3).map((r) => r.text);
    expect(top3.some((t) => t.includes("Paris") || t.includes("France"))).toBe(true);
  });

  // --- Ranking quality: closer results should be more relevant ---

  it("returns results sorted by ascending distance", async () => {
    const results = await search("database storage and caching");
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it("ranks database docs higher than unrelated docs for a DB query", async () => {
    const results = await search("database storage caching SQL");
    expect(results.length).toBeGreaterThan(2);
    // Top 2 should be Redis and/or PostgreSQL, not the cat
    const top2 = results.slice(0, 2).map((r) => r.text);
    expect(top2.some((t) => t.includes("Redis") || t.includes("PostgreSQL"))).toBe(true);
    // Cat should be further away
    const catIdx = results.findIndex((r) => r.text.includes("cat"));
    const dbIdx = results.findIndex((r) => r.text.includes("Redis") || r.text.includes("PostgreSQL"));
    if (catIdx >= 0 && dbIdx >= 0) {
      expect(catIdx).toBeGreaterThan(dbIdx);
    }
  });

  it("ranks programming docs higher for a code question", async () => {
    const results = await search("JavaScript function scope and component state");
    const top3 = results.slice(0, 3).map((r) => r.text);
    // Should find closures and/or React, not geography
    expect(top3.some((t) =>
      t.includes("closures") || t.includes("React") || t.includes("JavaScript"),
    )).toBe(true);
  });

  // --- Limit enforcement ---

  it("respects the limit parameter", async () => {
    const results = await search("anything", 2);
    expect(results.length).toBe(2);
  });

  // --- Result shape ---

  it("returns text, tags, source, and distance in each result", async () => {
    const results = await search("test");
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(typeof r.text).toBe("string");
    expect(typeof r.tags).toBe("string");
    expect(typeof r.source).toBe("string");
    expect(typeof r.distance).toBe("number");
    expect(r.distance).toBeGreaterThanOrEqual(0);
  });
});
