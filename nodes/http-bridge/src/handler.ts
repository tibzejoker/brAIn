import type { NodeHandler, TextPayload } from "@brain/sdk";

interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function parseRequest(content: string, overrides: Record<string, unknown>): HttpRequest | null {
  const defaultUrl = overrides.default_url as string | undefined;
  const defaultMethod = overrides.default_method as string | undefined;
  const defaultHeaders = overrides.default_headers as Record<string, string> | undefined;

  // Try JSON first
  try {
    const parsed = JSON.parse(content) as Partial<HttpRequest>;
    if (parsed.url) {
      return {
        url: parsed.url,
        method: parsed.method ?? defaultMethod ?? "GET",
        headers: { ...defaultHeaders, ...parsed.headers },
        body: parsed.body,
      };
    }
  } catch { /* Not JSON — treat content as URL */ }

  // Plain text = just a URL
  const url = content.trim();
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { url, method: defaultMethod ?? "GET", headers: defaultHeaders };
  }

  // If default_url configured, use content as body
  if (defaultUrl) {
    return { url: defaultUrl, method: defaultMethod ?? "POST", headers: defaultHeaders, body: content };
  }

  return null;
}

export const handler: NodeHandler = async (ctx) => {
  const overrides = ctx.node.config_overrides ?? {} as Record<string, unknown>;

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    if (!payload.content) continue;

    const req = parseRequest(payload.content, overrides);
    if (!req) {
      ctx.respond(JSON.stringify({
        error: "Invalid HTTP request: payload must be a URL or JSON with a 'url' field",
        received: payload.content.slice(0, 120),
        expected_formats: [
          "https://example.com",
          '{"url":"https://example.com","method":"GET"}',
        ],
        hint: "Send a valid URL or a JSON object with at least a 'url' field.",
      }));
      continue;
    }

    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      const responseBody = await response.text();

      ctx.respond(JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody.slice(0, 10000),
      }), { url: req.url, method: req.method });
    } catch (err) {
      ctx.respond(JSON.stringify({
        error: `${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }
};
