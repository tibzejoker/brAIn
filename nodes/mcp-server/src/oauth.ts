/**
 * OAuth 2.1 + DCR + PKCE provider for the mcp-server node.
 *
 * Implements `OAuthClientProvider` from the official MCP SDK so any
 * remote MCP server that requires OAuth (GitHub Copilot, Notion,
 * Linear OAuth-mode, Atlassian, …) Just Works through the standard
 * authorization-code flow.
 *
 * Storage: per `alias` JSON file under `data/mcp-oauth/`. Per-alias
 * (not per-nodeId) so an mcp-server respawn — even with a fresh
 * node id — still picks up the saved token and skips the consent
 * prompt. Tokens, registered client info, and the most recent PKCE
 * code verifier all live in the same file.
 *
 * Browser flow: the SDK calls `redirectToAuthorization(url)` when
 * the user needs to consent. We don't have a browser here — we
 * emit a structured event up to the handler which publishes it on
 * `mcp.<alias>.oauth.required`. The dashboard surfaces the URL as
 * a link, the user opens it, the auth server redirects to
 * `/mcp/oauth/callback`, the API publishes `mcp.<alias>.oauth.callback`
 * back on the bus carrying just `{code}` (the topic itself routes).
 *
 * State design: we override `state()` to embed `(nodeId, alias)`
 * base64url-encoded — nodeId helps the callback resolve to the
 * concrete instance for logging; routing happens by alias topic.
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

function storagePath(alias: string): string {
  // alias is user-provided (the JSON map key); keep filenames safe.
  const safe = alias.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(STORAGE_ROOT, `${safe}.json`);
}

function loadState(alias: string): PersistedState {
  const path = storagePath(alias);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PersistedState;
  } catch (err) {
    logger.warn({ err, path }, "mcp-oauth: failed to read storage; starting fresh");
    return {};
  }
}

function saveState(alias: string, state: PersistedState): void {
  const path = storagePath(alias);
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

export class BrainOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly nodeId: string,
    private readonly alias: string,
    private readonly emit: OAuthEmit,
  ) {}

  get redirectUrl(): string { return REDIRECT_URL; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `brAIn-mcp:${this.alias}`,
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return encodeState(this.nodeId, this.alias, randomUUID());
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return loadState(this.alias).clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const s = loadState(this.alias);
    s.clientInformation = info as OAuthClientInformationFull;
    saveState(this.alias, s);
  }

  tokens(): OAuthTokens | undefined {
    return loadState(this.alias).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const s = loadState(this.alias);
    s.tokens = tokens;
    saveState(this.alias, s);
  }

  saveCodeVerifier(codeVerifier: string): void {
    const s = loadState(this.alias);
    s.codeVerifier = codeVerifier;
    saveState(this.alias, s);
  }

  codeVerifier(): string {
    const s = loadState(this.alias);
    if (!s.codeVerifier) throw new Error(`mcp-oauth: no code verifier saved for ${this.alias}`);
    return s.codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const stateParam = authorizationUrl.searchParams.get("state") ?? "";
    logger.info(
      { alias: this.alias, host: authorizationUrl.host },
      "mcp-oauth: authorization required — emitting bus event",
    );
    this.emit({
      kind: "auth-required",
      nodeId: this.nodeId,
      serverName: this.alias,
      authorizationUrl: authorizationUrl.toString(),
      state: stateParam,
    });
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const s = loadState(this.alias);
    if (scope === "all" || scope === "client") s.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") s.tokens = undefined;
    if (scope === "all" || scope === "verifier") s.codeVerifier = undefined;
    saveState(this.alias, s);
  }
}
