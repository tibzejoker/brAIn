/**
 * OAuth 2.1 + DCR + PKCE provider for the mcp-host node.
 *
 * Implements `OAuthClientProvider` from the official MCP SDK so any
 * remote MCP server that requires OAuth (GitHub Copilot, Notion,
 * Linear OAuth-mode, Atlassian, …) Just Works through the standard
 * authorization-code flow.
 *
 * Storage: per (nodeId, serverName) JSON file under
 * `data/mcp-oauth/`. Tokens, registered client info, and the most
 * recent PKCE code verifier all live in the same file.
 *
 * Browser flow: the SDK calls `redirectToAuthorization(url)` when
 * the user needs to consent. We don't have a browser here — we
 * publish a `mcp.host.oauth.required` message on the bus carrying
 * the URL + (nodeId, serverName, state). The dashboard renders a
 * link the user clicks; the GitHub-style provider then redirects
 * to our `/mcp/oauth/callback` endpoint with the auth code; the
 * API publishes `mcp.host.oauth.callback` back on the bus, the
 * mcp-host calls `transport.finishAuth(code)`, retries connect.
 *
 * State design: we override `state()` to embed `nodeId/serverName`
 * (base64url-encoded JSON) so the callback handler can route the
 * code back to the right server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { logger } from "@brain/core";

export interface OAuthEvent {
  kind: "auth-required";
  nodeId: string;
  serverName: string;
  authorizationUrl: string;
  state: string;
}

interface PersistedState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

const STORAGE_ROOT = resolve(process.cwd(), "data", "mcp-oauth");
const REDIRECT_URL = process.env.BRAIN_OAUTH_REDIRECT_URL
  ?? "http://localhost:3000/mcp/oauth/callback";

function storagePath(nodeId: string, serverName: string): string {
  // serverName may contain anything user-provided; keep filenames safe.
  const safe = serverName.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(STORAGE_ROOT, `${nodeId}__${safe}.json`);
}

function loadState(nodeId: string, serverName: string): PersistedState {
  const path = storagePath(nodeId, serverName);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PersistedState;
  } catch (err) {
    logger.warn({ err, path }, "mcp-oauth: failed to read storage; starting fresh");
    return {};
  }
}

function saveState(nodeId: string, serverName: string, state: PersistedState): void {
  const path = storagePath(nodeId, serverName);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export type OAuthEmit = (event: OAuthEvent) => void;

/**
 * Encodes the OAuth state parameter so the callback can recover
 * which (nodeId, serverName) initiated the flow. The SDK passes
 * whatever we return through to the authorization URL and back.
 */
function encodeState(nodeId: string, serverName: string, nonce: string): string {
  return Buffer.from(JSON.stringify({ n: nodeId, s: serverName, x: nonce })).toString("base64url");
}

export function decodeState(s: string): { nodeId: string; serverName: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf-8")) as { n?: string; s?: string };
    if (typeof obj.n !== "string" || typeof obj.s !== "string") return null;
    return { nodeId: obj.n, serverName: obj.s };
  } catch { return null; }
}

export interface BrainOAuthOptions {
  /** Pre-registered OAuth client_id (skips DCR). */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

export class BrainOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly nodeId: string,
    private readonly serverName: string,
    private readonly emit: OAuthEmit,
    private readonly opts: BrainOAuthOptions = {},
  ) {}

  get redirectUrl(): string { return REDIRECT_URL; }

  get clientMetadata(): OAuthClientMetadata {
    const md: OAuthClientMetadata = {
      client_name: `brAIn-mcp-host:${this.nodeId.slice(0, 8)}/${this.serverName}`,
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
    };
    if (this.opts.scope) md.scope = this.opts.scope;
    return md;
  }

  state(): string {
    return encodeState(this.nodeId, this.serverName, randomUUID());
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Pre-registered creds take precedence over anything stored from
    // a previous DCR attempt — needed for servers (GitHub Copilot
    // MCP) that don't support DCR and require a user-created OAuth
    // App.
    if (this.opts.clientId) {
      return {
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        redirect_uris: [REDIRECT_URL],
      } as OAuthClientInformationFull;
    }
    const s = loadState(this.nodeId, this.serverName);
    return s.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const s = loadState(this.nodeId, this.serverName);
    s.clientInformation = info as OAuthClientInformationFull;
    saveState(this.nodeId, this.serverName, s);
  }

  tokens(): OAuthTokens | undefined {
    return loadState(this.nodeId, this.serverName).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const s = loadState(this.nodeId, this.serverName);
    s.tokens = tokens;
    saveState(this.nodeId, this.serverName, s);
  }

  saveCodeVerifier(codeVerifier: string): void {
    const s = loadState(this.nodeId, this.serverName);
    s.codeVerifier = codeVerifier;
    saveState(this.nodeId, this.serverName, s);
  }

  codeVerifier(): string {
    const s = loadState(this.nodeId, this.serverName);
    if (!s.codeVerifier) throw new Error(`mcp-oauth: no code verifier saved for ${this.serverName}`);
    return s.codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Extract the state we encoded so the dashboard can route the
    // user back unambiguously. Keep the URL otherwise unchanged.
    const stateParam = authorizationUrl.searchParams.get("state") ?? "";
    logger.info(
      { server: this.serverName, host: authorizationUrl.host },
      "mcp-oauth: authorization required — emitting bus event",
    );
    this.emit({
      kind: "auth-required",
      nodeId: this.nodeId,
      serverName: this.serverName,
      authorizationUrl: authorizationUrl.toString(),
      state: stateParam,
    });
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const s = loadState(this.nodeId, this.serverName);
    if (scope === "all" || scope === "client") s.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") s.tokens = undefined;
    if (scope === "all" || scope === "verifier") s.codeVerifier = undefined;
    saveState(this.nodeId, this.serverName, s);
  }
}
