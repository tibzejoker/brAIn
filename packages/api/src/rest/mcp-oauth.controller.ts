import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { BrainService } from "@brain/core";

/**
 * OAuth callback target for the mcp-host node's authorization flow.
 *
 * The mcp-host's `BrainOAuthProvider` registers this URL as the
 * `redirect_uris[0]` during DCR. After the user consents at the
 * authorization server, the browser lands here with `?code=…&state=…`.
 *
 * State is base64url-encoded JSON `{ n: nodeId, s: serverName, x: nonce }`
 * so we can route the code back to the right mcp-host instance via
 * the bus on `mcp.host.oauth.callback`. The corresponding mcp-host
 * subscriber decodes it, calls `transport.finishAuth(code)`, and
 * resumes the connection.
 *
 * The page rendered to the browser is intentionally tiny — it
 * acknowledges success and closes itself if the auth window was
 * opened in a popup, so the user goes back to the dashboard cleanly.
 */
@Controller("mcp/oauth")
export class MCPOAuthController {
  constructor(private readonly brain: BrainService) {}

  @Get("callback")
  callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ): void {
    if (error || !code || !state) {
      const reason = error ? `${error}: ${errorDescription ?? ""}` : "missing code or state";
      res.status(400).send(html(false, reason));
      return;
    }

    const decoded = decodeState(state);
    if (!decoded) {
      res.status(400).send(html(false, "malformed state parameter"));
      return;
    }

    // Route the code back to the right node via the bus on the
    // alias-scoped topic `mcp.<alias>.oauth.callback`. Payload is
    // just `{code}` since the topic itself does the routing.
    // Publishing from `system.api` keeps anti-loop happy so the
    // node actually receives its own callback.
    this.brain.bus.publish({
      from: "system.api",
      topic: `mcp.${decoded.serverName}.oauth.callback`,
      type: "text", criticality: 5,
      payload: { content: JSON.stringify({ code }) },
      metadata: { node_id: decoded.nodeId, alias: decoded.serverName },
    });

    res.status(200).send(html(true, decoded.serverName));
  }
}

function decodeState(state: string): { nodeId: string; serverName: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(state, "base64url").toString("utf-8")) as {
      n?: string; s?: string;
    };
    if (typeof obj.n !== "string" || typeof obj.s !== "string") return null;
    return { nodeId: obj.n, serverName: obj.s };
  } catch { return null; }
}

function html(ok: boolean, detail: string): string {
  const title = ok ? "Authorized" : "Authorization failed";
  const color = ok ? "#10b981" : "#ef4444";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} — brAIn MCP</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;margin:0;padding:48px;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{max-width:480px;text-align:center}
h1{color:${color};margin:0 0 12px;font-size:18px;font-weight:600}
p{color:#888;font-size:13px;line-height:1.5;margin:8px 0}
code{font-family:'SF Mono',Menlo,monospace;background:#1a1a1a;padding:2px 6px;border-radius:4px;color:#e5e5e5}
</style></head>
<body><div class="card">
<h1>${ok ? "✓ Authorized" : "✗ Authorization failed"}</h1>
<p>${ok ? `MCP server <code>${escapeHtml(detail)}</code> received the auth code.` : escapeHtml(detail)}</p>
<p>You can close this window and return to the brAIn dashboard.</p>
</div>
<script>setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}
