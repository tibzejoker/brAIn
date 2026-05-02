/**
 * Connection / reconcile / finishOAuth — the actual MCP client
 * lifecycle for a mcp-host instance. Lives in its own file so the
 * handler can stay under the 300-line lint cap as more bus topics
 * land.
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
  server: string;
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

export interface Instance {
  servers: Map<string, ServerEntry>;
}

function buildTransport(spec: NormalizedSpec, nodeId: string, emit: (e: OAuthEvent) => void): AnyTransport {
  const oauthOpts = {
    clientId: spec.oauthClientId,
    clientSecret: spec.oauthClientSecret,
    scope: spec.oauthScope,
  };
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
        authProvider: new BrainOAuthProvider(nodeId, spec.name, emit, oauthOpts),
      });
    }
    case "sse": {
      const headers = expandRecord(spec.headers);
      return new SSEClientTransport(new URL(spec.url ?? ""), {
        requestInit: headers ? { headers } : undefined,
        authProvider: new BrainOAuthProvider(nodeId, spec.name, emit, oauthOpts),
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
    { name: `brAIn-mcp-host:${spec.name}`, version: "0.3.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const list = await client.listTools();
    const tools: ToolDescriptor[] = list.tools.map((t) => ({
      server: spec.name, name: t.name,
      description: t.description ?? "", inputSchema: t.inputSchema,
    }));
    return { spec, client, transport, tools, connectedAt: Date.now(), specHash, status: "connected" };
  } catch (err) {
    if (err instanceof UnauthorizedError && pendingAuthCapture.url
        && (spec.transport === "http" || spec.transport === "sse")) {
      logger.info({ server: spec.name }, "mcp-host: OAuth required, parked");
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

export async function reconcile(
  inst: Instance,
  nodeId: string,
  desired: NormalizedSpec[],
  emit: (e: OAuthEvent) => void,
): Promise<void> {
  const desiredByName = new Map(desired.map((s) => [s.name, s]));
  for (const [name, entry] of [...inst.servers]) {
    const want = desiredByName.get(name);
    if (!want || hashSpec(want) !== entry.specHash) {
      await disconnect(entry);
      inst.servers.delete(name);
    }
  }
  for (const spec of desired) {
    if (inst.servers.has(spec.name)) continue;
    const entry = await connectOne(nodeId, spec, emit);
    inst.servers.set(spec.name, entry);
    if (entry.status === "connected") {
      logger.info({ server: spec.name, tools: entry.tools.length }, "mcp-host: connected");
    } else if (entry.status === "pending-auth") {
      logger.info({ server: spec.name, url: entry.authorizationUrl }, "mcp-host: awaiting OAuth consent");
    } else {
      logger.error({ server: spec.name, error: entry.error }, "mcp-host: failed to connect");
    }
  }
}

/**
 * Resume an OAuth flow after the browser callback delivered the
 * authorization code.
 *
 * The SDK transport can't be re-`start()`ed (which is what
 * client.connect() does), so we use the parked transport ONLY to
 * call `finishAuth(code)` — that exchanges the code for tokens and
 * persists them via our OAuthClientProvider.saveTokens. We then
 * close the parked transport, build a fresh one (its authProvider
 * loads the saved tokens automatically), and connect normally.
 */
export async function finishOAuth(
  inst: Instance,
  nodeId: string,
  serverName: string,
  code: string,
  emit: (e: OAuthEvent) => void,
): Promise<void> {
  const entry = inst.servers.get(serverName);
  if (!entry || entry.status !== "pending-auth") return;
  try {
    // Step 1: exchange the code → tokens are persisted via the
    // OAuthClientProvider on the (still-parked) transport.
    await entry.transport.finishAuth(code);
    // Step 2: dispose the parked transport — it's already started
    // and can't be reused for another connect().
    try { await entry.transport.close(); } catch { /* ignore */ }
    try { await entry.client.close(); } catch { /* ignore */ }
    // Step 3: rebuild a fresh transport. Its authProvider will load
    // the access token we just persisted, so connect() succeeds
    // without prompting again.
    const fresh = await connectOne(nodeId, entry.spec, emit);
    inst.servers.set(serverName, fresh);
    if (fresh.status === "connected") {
      logger.info({ server: serverName, tools: fresh.tools.length }, "mcp-host: OAuth completed, connected");
    } else if (fresh.status === "pending-auth") {
      logger.warn({ server: serverName }, "mcp-host: still pending after OAuth — token rejected?");
    } else {
      logger.error({ server: serverName, error: fresh.error }, "mcp-host: post-OAuth connect failed");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    inst.servers.set(serverName, {
      spec: entry.spec, status: "error",
      error: `OAuth callback failed: ${errMsg}`, specHash: entry.specHash,
    });
    logger.error({ err, server: serverName }, "mcp-host: OAuth callback failed");
  }
}
