import { useCallback, useState } from "react";

/**
 * Modal for the "Join existing hub" flow. The primary path is pasting
 * a `brain://join?url=…&token=…` URI (or a bare `nats://…`) — it auto-
 * fills the URL + token below. Users without a URI can still type the
 * pieces manually.
 */
export function JoinHubModal({ onCancel, onSubmit }: {
  onCancel: () => void;
  onSubmit: (url: string, token: string, hubName: string) => void;
}): React.ReactElement {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [hubName, setHubName] = useState("");
  const [uri, setUri] = useState("");
  const [uriHint, setUriHint] = useState<"empty" | "parsed" | "raw" | "invalid">("empty");

  const applyUri = useCallback((raw: string): void => {
    setUri(raw);
    const trimmed = raw.trim();
    if (!trimmed) { setUriHint("empty"); return; }
    try {
      // 1) brain://join?url=…&token=… — mobile/desktop deep link.
      if (trimmed.startsWith("brain://")) {
        const q = new URL(trimmed).searchParams;
        const u = q.get("url"); const t = q.get("token");
        if (u) setUrl(u);
        if (t) setToken(t);
        setUriHint(u ? "parsed" : "invalid");
        return;
      }
      // 2) Bash / PowerShell snippet — same shape the dashboard prints
      //    on the "Invite a node" tab. Matches both
      //        BRAIN_NATS_URL=nats://host:port BRAIN_NATS_TOKEN=hex node …
      //        $env:BRAIN_NATS_URL="nats://host:port"; $env:BRAIN_NATS_TOKEN="hex"; node …
      //    by scanning for the env-var names anywhere in the input
      //    (optional quotes, optional `$env:` prefix). Token is
      //    optional — hubs without auth just omit it.
      const urlMatch = trimmed.match(/BRAIN_NATS_URL\s*=\s*"?(nats:\/\/[^\s";]+)/i);
      const tokMatch = trimmed.match(/BRAIN_NATS_TOKEN\s*=\s*"?([^\s";]+)/i);
      if (urlMatch) {
        setUrl(urlMatch[1]);
        if (tokMatch) setToken(tokMatch[1]);
        setUriHint("parsed");
        return;
      }
      // 3) Bare nats:// URL — paste with no token.
      if (/^nats:\/\//i.test(trimmed)) {
        setUrl(trimmed);
        setUriHint("raw");
        return;
      }
      setUriHint("invalid");
    } catch { setUriHint("invalid"); }
  }, []);

  const valid = /^nats:\/\/\S+/i.test(url.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="w-full max-w-md bg-surface-raised border border-border rounded-lg shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Join an existing brAIn hub</h3>
          <button onClick={onCancel} className="text-text-muted hover:text-text text-lg leading-none">&times;</button>
        </div>
        <p className="text-[11px] text-text-muted">
          Point this dashboard at another hub's NATS broker. The local API will restart in <code className="font-mono">external</code> mode.
        </p>

        <div>
          <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
            Paste anything <span className="text-text-muted/60">(join URI, nats:// URL, or a copied agent command — fills the fields below)</span>
          </label>
          <input
            type="text"
            value={uri}
            onChange={(e) => applyUri(e.target.value)}
            placeholder="brain://join?…  ·  nats://host:port  ·  BRAIN_NATS_URL=…  ·  $env:BRAIN_NATS_URL=…"
            className="w-full px-2 py-1.5 text-xs rounded bg-surface border border-border focus:border-accent focus:outline-none text-text font-mono"
          />
          {uriHint === "parsed" && <p className="mt-1 text-[10px] text-node-active">Auto-filled URL{token ? " + token" : ""} below.</p>}
          {uriHint === "raw" && <p className="mt-1 text-[10px] text-node-active">Used as the broker URL below — add a token if the hub needs one.</p>}
          {uriHint === "invalid" && <p className="mt-1 text-[10px] text-node-stopped">Not a recognised URI — fill the fields manually.</p>}
        </div>

        <div className="border-t border-border pt-3 space-y-2.5">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">Broker URL <span className="text-node-stopped">*</span></label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="nats://192.168.1.16:4222"
              className="w-full max-w-xs px-2 py-1.5 text-xs rounded bg-surface border border-border focus:border-accent focus:outline-none text-text font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">Token</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="(if required)"
                className="w-full px-2 py-1.5 text-xs rounded bg-surface border border-border focus:border-accent focus:outline-none text-text font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">Label</label>
              <input
                type="text"
                value={hubName}
                onChange={(e) => setHubName(e.target.value)}
                placeholder="Alice's mac"
                className="w-full px-2 py-1.5 text-xs rounded bg-surface border border-border focus:border-accent focus:outline-none text-text"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onCancel} className="px-3 py-1 text-xs rounded text-text-muted hover:text-text">
            Cancel
          </button>
          <button
            onClick={() => onSubmit(url, token, hubName)}
            disabled={!valid}
            className="px-3 py-1 text-xs rounded bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Join &amp; restart
          </button>
        </div>
      </div>
    </div>
  );
}
