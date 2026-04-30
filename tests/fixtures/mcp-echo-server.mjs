#!/usr/bin/env node
/**
 * Tiny MCP server for tests — exposes one tool "echo" that returns
 * its input. Runs over stdio, so the brAIn mcp-host node can spawn
 * it as a child process via StdioClientTransport.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "brAIn-test-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "Return the input string verbatim, prefixed with [echo].",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "echo") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const text = req.params.arguments?.text ?? "";
  return {
    content: [{ type: "text", text: `[echo] ${text}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
