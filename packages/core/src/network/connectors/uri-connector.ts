/**
 * URI connector — the default {@link PeerConnector}.
 *
 * Parses the three shapes the dashboard accepts today, plus the new
 * `&api=` HTTP base needed for the merged guest view:
 *   1. `brain://join?url=nats://…&token=…&api=http://…&label=…` deep link
 *   2. the bash/PowerShell invite snippet (`BRAIN_NATS_URL=… BRAIN_NATS_TOKEN=…`)
 *   3. a bare `nats://host:port` URL
 *
 * Logic lifted out of the React `JoinHubModal` so every client — the
 * dashboard, a CLI, a future Flutter app — parses invites identically.
 */
import type { JoinDescriptor, PeerConnector } from "./types";

const NATS_URL_RE = /^nats:\/\/\S+/i;
const SNIPPET_URL_RE = /BRAIN_NATS_URL\s*=\s*"?(nats:\/\/[^\s";]+)/i;
const SNIPPET_TOK_RE = /BRAIN_NATS_TOKEN\s*=\s*"?([^\s";]+)/i;

export class UriConnector implements PeerConnector {
  readonly name = "uri";

  canParse(input: string): boolean {
    const t = input.trim();
    return (
      t.startsWith("brain://") ||
      NATS_URL_RE.test(t) ||
      SNIPPET_URL_RE.test(t)
    );
  }

  parse(input: string): JoinDescriptor | null {
    const t = input.trim();
    if (!t) return null;
    try {
      // 1) brain://join?url=…&token=…&api=…&label=…
      if (t.startsWith("brain://")) {
        const q = new URL(t).searchParams;
        const nats = q.get("url");
        if (!nats || !NATS_URL_RE.test(nats)) return null;
        return clean({
          nats_url: nats,
          token: q.get("token") ?? undefined,
          http_url: q.get("api") ?? undefined,
          hub_label: q.get("label") ?? undefined,
        });
      }
      // 2) bash / PowerShell invite snippet
      const snip = t.match(SNIPPET_URL_RE);
      if (snip) {
        const tok = t.match(SNIPPET_TOK_RE);
        return clean({ nats_url: snip[1], token: tok?.[1] });
      }
      // 3) bare nats:// URL
      if (NATS_URL_RE.test(t)) return clean({ nats_url: t });
      return null;
    } catch {
      return null;
    }
  }

  /** Produce the canonical `brain://join?...` deep link. */
  format(desc: JoinDescriptor): string {
    const q = new URLSearchParams({ url: desc.nats_url });
    if (desc.token) q.set("token", desc.token);
    if (desc.http_url) q.set("api", desc.http_url);
    if (desc.hub_label) q.set("label", desc.hub_label);
    return `brain://join?${q.toString()}`;
  }
}

/** Strip empty optionals so callers can `if (desc.token)` cleanly. */
function clean(d: JoinDescriptor): JoinDescriptor {
  return {
    nats_url: d.nats_url,
    ...(d.token ? { token: d.token } : {}),
    ...(d.http_url ? { http_url: d.http_url } : {}),
    ...(d.hub_label ? { hub_label: d.hub_label } : {}),
  };
}
