import type { NodeHandler, TextPayload } from "@brain/sdk";

interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpConfig {
  response_topic?: string;
  default_url?: string;
  default_method?: string;
  default_headers?: Record<string, string>;
}

function getConfig(overrides: Record<string, unknown>): HttpConfig {
  return {
    response_topic: overrides.response_topic as string | undefined,
    default_url: overrides.default_url as string | undefined,
    default_method: overrides.default_method as string | undefined,
    default_headers: overrides.default_headers as Record<string, string> | undefined,
  };
}

function parseRequest(content: string, config: HttpConfig): HttpRequest | null {
  // Try JSON first
  try {
    const parsed = JSON.parse(content) as Partial<HttpRequest>;
    if (parsed.url) {
      return {
        url: parsed.url,
        method: parsed.method ?? config.default_method ?? "GET",
        headers: { ...config.default_headers, ...parsed.headers },
        body: parsed.body,
      };
    }
  } catch {
    // Not JSON — treat content as URL
  }

  // Plain text = just a URL
  const url = content.trim();
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return {
      url,
      method: config.default_method ?? "GET",
      headers: config.default_headers,
    };
  }

  // If default_url configured, use content as body
  if (config.default_url) {
    return {
      url: config.default_url,
      method: config.default_method ?? "POST",
      headers: config.default_headers,
      body: content,
    };
  }

  return null;
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const responseTopic = config.response_topic ?? `http.response.${ctx.node.name}`;

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    if (!payload.content) continue;

    const req = parseRequest(payload.content, config);
    if (!req) {
      ctx.publish(responseTopic, {
        type: "alert",
        criticality: 3,
        payload: {
          title: "Invalid HTTP request",
          description: `Could not parse request from message: ${payload.content.slice(0, 100)}`,
        },
      });
      continue;
    }

    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });

      const responseBody = await response.text();

      ctx.publish(responseTopic, {
        type: "text",
        criticality: msg.criticality,
        payload: {
          content: JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody.slice(0, 10000),
          }),
        },
        metadata: {
          original_topic: msg.topic,
          original_message_id: msg.id,
          url: req.url,
          method: req.method,
        },
      });
    } catch (err) {
      ctx.publish(responseTopic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: "HTTP request failed",
          description: `${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
};
