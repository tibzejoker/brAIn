/**
 * Parse one mcp-server config_overrides entry into a normalized spec.
 *
 * Shape: `{ alias: "<short-name>", spec: { type|command|url|... } }`.
 *
 * - `alias` is the topic prefix used for `mcp.<alias>.<tool>` etc.
 * - `spec` follows the same conventions as Claude Desktop / Cursor:
 *   `command` → stdio, `url` → http (Streamable, default for remote),
 *   explicit `type: "sse" | "ws"` overrides. `${env:VAR}` interpolation
 *   in headers / args / env keeps secrets out of the persisted config.
 */

export interface NormalizedSpec {
  alias: string;
  transport: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export function expandEnv(input: string): string {
  return input.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => process.env[v] ?? "");
}

export function expandRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandEnv(v);
  return out;
}

export function expandArgs(args?: string[]): string[] | undefined {
  return args?.map((a) => expandEnv(a));
}

export function parseSpec(overrides: Record<string, unknown>): NormalizedSpec | null {
  const alias = typeof overrides.alias === "string" ? overrides.alias : null;
  const raw = typeof overrides.spec === "object" && overrides.spec !== null
    ? overrides.spec as Record<string, unknown>
    : null;
  if (!alias || !raw) return null;

  const cmd = typeof raw.command === "string" ? raw.command : undefined;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const explicit = typeof raw.transport === "string"
    ? raw.transport
    : typeof raw.type === "string" ? raw.type : undefined;

  let transport: NormalizedSpec["transport"];
  if (explicit === "stdio") transport = "stdio";
  else if (explicit === "sse") transport = "sse";
  else if (explicit === "ws" || explicit === "websocket") transport = "ws";
  else if (explicit === "http" || explicit === "streamable-http") transport = "http";
  else if (cmd) transport = "stdio";
  else if (url) transport = "http";
  else return null;

  if (transport === "stdio" && !cmd) return null;
  if (transport !== "stdio" && !url) return null;

  return {
    alias,
    transport,
    command: cmd,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : undefined,
    env: typeof raw.env === "object" && raw.env !== null ? raw.env as Record<string, string> : undefined,
    url,
    headers: typeof raw.headers === "object" && raw.headers !== null ? raw.headers as Record<string, string> : undefined,
  };
}

/** Stable JSON hash of a spec — detects "config changed → reconnect". */
export function hashSpec(spec: NormalizedSpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}
