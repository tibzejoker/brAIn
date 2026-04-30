#!/usr/bin/env node
/**
 * Minimal Streamable-HTTP MCP server for tests. Exposes one tool
 * "ping" that echoes back. Listens on the port given as argv[2].
 *
 * Stateless mode (sessionIdGenerator: undefined) keeps the test
 * trivial — no need to track sessions across requests.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const port = Number(process.argv[2] ?? 0);
if (!port) { console.error("usage: mcp-http-server.mjs <port>"); process.exit(1); }

const mcp = new Server(
  { name: "brAIn-test-http-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{
    name: "ping",
    description: "Return the input prefixed with [pong-http].",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, (req) => {
  if (req.params.name !== "ping") throw new Error(`unknown tool: ${req.params.name}`);
  const text = req.params.arguments?.text ?? "";
  return { content: [{ type: "text", text: `[pong-http] ${text}` }] };
});

// Session-based transport — the SDK client expects a Mcp-Session-Id
// in the initialize response and reuses it on subsequent requests.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
await mcp.connect(transport);

const server = http.createServer(async (req, res) => {
  if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
  // Collect body bytes, parse JSON only for POST. The SDK reads
  // parsedBody when supplied; passing undefined makes it reparse
  // the stream which has already been consumed → 4xx.
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8")); }
    catch { body = undefined; }
    await transport.handleRequest(req, res, body);
  } else {
    await transport.handleRequest(req, res);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mcp-http-server listening on 127.0.0.1:${port}`);
});

const shutdown = async () => {
  try { await transport.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
