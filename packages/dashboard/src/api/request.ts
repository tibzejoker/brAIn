/**
 * Tiny fetch wrapper shared across the API client modules.
 * Throws on non-2xx with the raw body in the message so React
 * components can surface the server's error verbatim.
 */
const BASE = "";

/**
 * Broker token for THIS hub, attached as `Authorization: Bearer` on
 * same-origin mutations so they pass the hub's BrokerTokenGuard. Set once
 * at startup from `GET /network/transport`. Cross-hub calls (a `baseUrl`
 * override targeting another machine's API — e.g. loading a remote node's
 * UI) don't get it: we don't hold the remote hub's token, and mutating
 * ops on remote nodes go over the already-authenticated bus instead.
 */
let apiToken: string | null = null;
export function setApiToken(token: string | null): void {
  apiToken = token;
}

export async function request<T>(
  path: string,
  opts?: RequestInit & { baseUrl?: string },
): Promise<T> {
  const { baseUrl, headers: optHeaders, ...rest } = opts ?? {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(optHeaders as Record<string, string> | undefined),
  };
  if (apiToken && !baseUrl && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }
  const res = await fetch(`${baseUrl ?? BASE}${path}`, { ...rest, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
