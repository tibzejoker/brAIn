/**
 * Config parsing for the mcp-host node — separated so handler.ts
 * stays under the 300-line lint cap.
 *
 * Accepts the de-facto-standard `mcpServers` map (Claude Desktop /
 * Cursor / Cline …) AND the legacy `servers: [{name, …}]` array.
 *
 * Auto-discriminates transport from fields: `command` → stdio,
 * `url` → http (Streamable, default for remote), explicit
 * `type: "sse" | "ws"` overrides.
 *
 * `${env:VAR}` interpolation in headers / args / env keeps secrets
 * out of the persisted config.
 */

export interface NormalizedSpec {
  name: string;
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

export function normalizeSpec(name: string, raw: Record<string, unknown>): NormalizedSpec | null {
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
    name,
    transport,
    command: cmd,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : undefined,
    env: typeof raw.env === "object" && raw.env !== null ? raw.env as Record<string, string> : undefined,
    url,
    headers: typeof raw.headers === "object" && raw.headers !== null ? raw.headers as Record<string, string> : undefined,
  };
}

export function parseSpecs(overrides: Record<string, unknown>): NormalizedSpec[] {
  const out: NormalizedSpec[] = [];
  const map = overrides.mcpServers;
  if (typeof map === "object" && map !== null && !Array.isArray(map)) {
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const spec = normalizeSpec(name, raw as Record<string, unknown>);
      if (spec) out.push(spec);
    }
  }
  const arr = overrides.servers;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== "string") continue;
      const spec = normalizeSpec(r.name, r);
      if (spec) out.push(spec);
    }
  }
  return out;
}

/** Stable JSON hash of a spec — detects "config changed → reconnect". */
export function hashSpec(spec: NormalizedSpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}
