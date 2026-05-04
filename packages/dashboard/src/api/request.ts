/**
 * Tiny fetch wrapper shared across the API client modules.
 * Throws on non-2xx with the raw body in the message so React
 * components can surface the server's error verbatim.
 */
const BASE = "";

export async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
