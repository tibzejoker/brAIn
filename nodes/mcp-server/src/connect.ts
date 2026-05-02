/**
 * Connection lifecycle for ONE MCP server. Owns the SDK client +
 * transport + tools list + status.
 *
 * The OAuth dance is delegated to BrainOAuthProvider — `connectOne`
 * traps `UnauthorizedError`, parks the (already-started) transport,
 * and surfaces the consent URL so the caller (handler) can publish it
 * on the bus. After the user consents, `finishOAuth(code)` exchanges
 * the code, closes the parked transport, and rebuilds a fresh one
 * whose authProvider loads the persisted token.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { logger } from "@brain/core";
import {
  type NormalizedSpec, expandArgs, expandRecord, hashSpec,
} from "./parse";
import { BrainOAuthProvider, type OAuthEvent } from "./oauth";

export type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport
  | WebSocketClientTransport;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ConnectedServer {
  spec: NormalizedSpec;
  client: Client;
  transport: AnyTransport;
  tools: ToolDescriptor[];
  connectedAt: number;
  specHash: string;
  status: "connected";
  error?: undefined;
}

export interface FailedServer {
  spec: NormalizedSpec;
  status: "error";
  error: string;
  specHash: string;
}

export interface PendingAuthServer {
  spec: NormalizedSpec;
  status: "pending-auth";
  authorizationUrl: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  specHash: string;
}

export type ServerEntry = ConnectedServer | FailedServer | PendingAuthServer;

function buildTransport(spec: NormalizedSpec, nodeId: string, emit: (e: OAuthEvent) => void): AnyTransport {
  switch (spec.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: spec.command ?? "",
        args: expandArgs(spec.args) ?? [],
        env: expandRecord(spec.env),
      });
    case "http": {
      const headers = expandRecord(spec.headers);
      return new StreamableHTTPClientTransport(new URL(spec.url ?? ""), {
        requestInit: headers ? { headers } : undefined,
        authProvider: new BrainOAuthProvider(nodeId, spec.alias, emit),
      });
    }
    case "sse": {
      const headers = expandRecord(spec.headers);
      return new SSEClientTransport(new URL(spec.url ?? ""), {
        requestInit: headers ? { headers } : undefined,
        authProvider: new BrainOAuthProvider(nodeId, spec.alias, emit),
      });
    }
    case "ws":
      return new WebSocketClientTransport(new URL(spec.url ?? ""));
  }
}

export async function connectOne(
  nodeId: string,
  spec: NormalizedSpec,
  emit: (e: OAuthEvent) => void,
): Promise<ServerEntry> {
  const specHash = hashSpec(spec);
  const pendingAuthCapture: { url?: string } = {};
  const transport = buildTransport(spec, nodeId, (event) => {
    pendingAuthCapture.url = event.authorizationUrl;
    emit(event);
  });
  const client = new Client(
    { name: `brAIn-mcp-server:${spec.alias}`, version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const list = await client.listTools();
    const tools: ToolDescriptor[] = list.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
    return { spec, client, transport, tools, connectedAt: Date.now(), specHash, status: "connected" };
  } catch (err) {
    if (err instanceof UnauthorizedError && pendingAuthCapture.url
        && (spec.transport === "http" || spec.transport === "sse")) {
      logger.info({ alias: spec.alias }, "mcp-server: OAuth required, parked");
      return {
        spec, status: "pending-auth",
        authorizationUrl: pendingAuthCapture.url,
        client,
        transport: transport as StreamableHTTPClientTransport | SSEClientTransport,
        specHash,
      };
    }
    return { spec, status: "error", error: err instanceof Error ? err.message : String(err), specHash };
  }
}

export async function disconnect(entry: ServerEntry): Promise<void> {
  if (entry.status === "error") return;
  try { await entry.client.close(); } catch { /* ignore */ }
  try { await entry.transport.close(); } catch { /* ignore */ }
}

/**
 * Resume an OAuth flow after the browser callback delivered the
 * authorization code. The SDK transport can't be re-`start()`ed
 * (which is what client.connect() does), so we use the parked
 * transport ONLY to call `finishAuth(code)` — that exchanges the
 * code for tokens and persists them via OAuthClientProvider. We then
 * close the parked transport, build a fresh one (its authProvider
 * loads the saved tokens automatically), and connect normally.
 */
export async function finishOAuth(
  entry: PendingAuthServer,
  nodeId: string,
  code: string,
  emit: (e: OAuthEvent) => void,
): Promise<ServerEntry> {
  try {
    await entry.transport.finishAuth(code);
    try { await entry.transport.close(); } catch { /* ignore */ }
    try { await entry.client.close(); } catch { /* ignore */ }
    return await connectOne(nodeId, entry.spec, emit);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      spec: entry.spec, status: "error",
      error: `OAuth callback failed: ${errMsg}`, specHash: entry.specHash,
    };
  }
}
