import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeContext, Message } from "@brain/sdk";

// === Mock fetch ===
const originalFetch = globalThis.fetch;

function mockFetchOk(body: string, status = 200): void {
  globalThis.fetch = vi.fn(async () => {
    return new Response(body, {
      status,
      statusText: status === 200 ? "OK" : "Not Found",
      headers: { "Content-Type": "text/html" },
    });
  }) as typeof fetch;
}

function mockFetchError(errorMsg: string): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error(errorMsg);
  }) as typeof fetch;
}

// === Mock NodeContext ===
function mockCtx(
  messages: Message[],
  configOverrides: Record<string, unknown> = {},
): NodeContext & {
  published: Array<{ topic: string; type: string; payload: unknown; metadata?: unknown }>;
  logs: Array<{ level: string; message: string }>;
  slept: boolean;
} {
  const published: Array<{ topic: string; type: string; payload: unknown; metadata?: unknown }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  let slept = false;

  return {
    messages,
    published,
    logs,
    get slept() { return slept; },
    readMessages: () => [],
    respond(content, metadata) {
      published.push({ topic: "http.response", type: "text", payload: { content }, metadata });
    },
    publish(topic, msg) { published.push({ topic, ...msg } as typeof published[0]); },
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
      id: "test-http",
      type: "http-bridge",
      name: "web-fetch",
      description: "",
      tags: [],
      authority_level: 0,
      state: "active",
      priority: 3,
      subscriptions: [],
      transport: "process",
      position: { x: 0, y: 0 },
      config_overrides: configOverrides,
      created_at: Date.now(),
    },
    iteration: 1,
    wasPreempted: false,
    preemptionContext: undefined,
  };
}

function makeMsg(topic: string, content: string, from = "brain-123"): Message {
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

describe("http-bridge handler", () => {
  let handler: (ctx: NodeContext) => Promise<void>;

  beforeEach(async () => {
    const mod = await import("../nodes/http-bridge/src/handler");
    handler = mod.handler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // === SLEEP ===

  it("does nothing when no messages", async () => {
    const ctx = mockCtx([]);
    await handler(ctx);
    expect(ctx.published).toHaveLength(0);
  });

  // === JSON request ===

  it("fetches a URL from JSON payload", async () => {
    mockFetchOk("<html>hello</html>");
    const ctx = mockCtx([
      makeMsg("http.request", JSON.stringify({ url: "https://example.com" })),
    ]);
    await handler(ctx);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "GET" }),
    );
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].type).toBe("text");
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.status).toBe(200);
    expect(body.body).toContain("hello");
  });

  it("supports POST with body from JSON", async () => {
    mockFetchOk('{"ok":true}');
    const ctx = mockCtx([
      makeMsg("http.request", JSON.stringify({
        url: "https://api.example.com/data",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"key":"value"}',
      })),
    ]);
    await handler(ctx);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "https://api.example.com/data",
      expect.objectContaining({ method: "POST", body: '{"key":"value"}' }),
    );
  });

  // === Plain URL ===

  it("fetches a plain URL string", async () => {
    mockFetchOk("page content");
    const ctx = mockCtx([
      makeMsg("http.request", "https://example.com/page"),
    ]);
    await handler(ctx);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ method: "GET" }),
    );
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].type).toBe("text");
  });

  it("fetches a URL with leading/trailing whitespace", async () => {
    mockFetchOk("ok");
    const ctx = mockCtx([
      makeMsg("http.request", "  https://example.com/trimmed  "),
    ]);
    await handler(ctx);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "https://example.com/trimmed",
      expect.anything(),
    );
  });

  // === Invalid requests ===

  it("rejects free text that is not a URL with helpful error", async () => {
    const ctx = mockCtx([
      makeMsg("http.request", "Top trends and predictions for AI development"),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].type).toBe("text");
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.error).toContain("Invalid HTTP request");
    expect(body.received).toContain("Top trends");
    expect(body.expected_formats).toBeDefined();
    expect(body.hint).toContain("URL");
  });

  it("rejects JSON without url field", async () => {
    const ctx = mockCtx([
      makeMsg("http.request", JSON.stringify({ method: "GET" })),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.error).toContain("Invalid HTTP request");
  });

  it("rejects empty content", async () => {
    const ctx = mockCtx([
      makeMsg("http.request", "   "),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.error).toContain("Invalid HTTP request");
  });

  // === Fetch errors ===

  it("handles network errors gracefully", async () => {
    mockFetchError("ECONNREFUSED");
    const ctx = mockCtx([
      makeMsg("http.request", "https://unreachable.example.com"),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(1);
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("handles HTTP error status codes", async () => {
    mockFetchOk("Not Found", 404);
    const ctx = mockCtx([
      makeMsg("http.request", "https://example.com/missing"),
    ]);
    await handler(ctx);

    // Non-2xx is still returned as text (not an alert)
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0].type).toBe("text");
    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.status).toBe(404);
  });

  // === Config: response_topic ===

  it("publishes via ctx.respond", async () => {
    mockFetchOk("ok");
    const ctx = mockCtx([makeMsg("http.request", "https://example.com")]);
    await handler(ctx);

    // respond() routes to the mock response topic
    expect(ctx.published[0].topic).toBe("http.response");
  });

  // === Config: default_url (API mode) ===

  it("uses default_url when content is not a URL", async () => {
    mockFetchOk('{"result":"ok"}');
    const ctx = mockCtx(
      [makeMsg("http.request", "search query text")],
      { default_url: "https://api.example.com/search", default_method: "POST" },
    );
    await handler(ctx);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "https://api.example.com/search",
      expect.objectContaining({ method: "POST", body: "search query text" }),
    );
  });

  // === Multiple messages ===

  it("processes multiple messages in one iteration", async () => {
    mockFetchOk("ok");
    const ctx = mockCtx([
      makeMsg("http.request", "https://example.com/a"),
      makeMsg("http.request", "https://example.com/b"),
    ]);
    await handler(ctx);

    expect(ctx.published).toHaveLength(2);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  // === Response body truncation ===

  it("truncates large response bodies", async () => {
    mockFetchOk("x".repeat(20000));
    const ctx = mockCtx([
      makeMsg("http.request", "https://example.com/big"),
    ]);
    await handler(ctx);

    const body = JSON.parse((ctx.published[0].payload as { content: string }).content);
    expect(body.body.length).toBeLessThanOrEqual(10000);
  });
});
