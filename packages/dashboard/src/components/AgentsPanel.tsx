import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getAgents, getTransport, setTransportBind, type AgentSnapshot, type TransportInfo } from "../api/client";

/**
 * Distributed runtime panel. The bus is always NATS — embedded by
 * default, or external when `BRAIN_NATS_URL` is set on the API.
 * This pane shows the broker URL (so remote `brain-agent` instances
 * know what to connect to) and the hosts currently announcing on it.
 *
 * UI-side we call them "remote nodes" since users think of the unit
 * of brAIn work as a node — code-side they're `Agent`s, hosts that
 * happen to run nodes for us.
 */
export function AgentsPanel(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [transport, setTransport] = useState<TransportInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    Promise.all([getAgents(), getTransport()])
      .then(([data, t]) => { setAgents(data); setTransport(t); setError(null); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Distributed</h2>
        <span className="text-xs text-text-muted">
          {agents.length} remote agent{agents.length === 1 ? "" : "s"} connected
        </span>
        <button
          onClick={refresh}
          className="ml-auto text-xs text-text-muted hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs bg-node-stopped/10 text-node-stopped">
          {error}
        </div>
      )}

      {transport && <TransportInfoView transport={transport} onChanged={refresh} />}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="text-text-muted text-xs py-8 text-center">Loading…</div>
        )}

        {!loading && agents.length === 0 && !error && (
          <div className="text-text-muted text-[11px] py-6 px-5 text-center space-y-1">
            <div>No remote agents connected yet.</div>
            <div className="text-text-muted/70">Copy the snippet above and run it on the machine you want to join.</div>
          </div>
        )}

        {agents.map((a) => (
          <div
            key={a.agent_id}
            className="px-5 py-4 border-b border-border/50 hover:bg-surface-overlay/50 transition-colors"
          >
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="shrink-0 w-2 h-2 rounded-full bg-node-active" />
              <span className="text-sm font-medium text-text mr-1">{a.host}</span>
              <span className="text-xs text-text-muted font-mono break-all">{a.agent_id}</span>
              <span className="ml-auto shrink-0 text-xs text-text-muted whitespace-nowrap">
                pid {a.pid} · up {formatUptime(Date.now() - a.started_at)}
              </span>
            </div>

            {a.types.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-1">
                {a.types.map((t) => (
                  <span
                    key={t}
                    title={`This agent can host a "${t}" node — spawn with transport: remote, target_agent_id: ${a.agent_id}`}
                    className="px-2 py-0.5 text-[11px] rounded bg-surface-overlay text-text-muted font-mono"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-text-muted italic mb-1">
                This remote announces no installable types — it's a passive bus client (e.g. brAIn-mobile). Publish to its topics directly instead of spawning here.
              </p>
            )}

            <p className="text-[11px] text-text-muted font-mono">
              last seen {Math.round((Date.now() - a.ts) / 1000)} s ago
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransportInfoView({ transport, onChanged }: {
  transport: TransportInfo;
  onChanged: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null);
  const [pickedIp, setPickedIp] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = transport.bind_address === "0.0.0.0";
  const isExternal = transport.mode === "external";
  const ip = pickedIp ?? (transport.lan_ips[0] as string | undefined) ?? "";

  // Auto-pick the right shell syntax for the visitor's OS, but let
  // them flip — Windows users SSHing into a Linux box need bash even
  // though their browser says Windows, and vice versa.
  type Shell = "bash" | "powershell";
  const [shell, setShell] = useState<Shell>(() => {
    if (typeof navigator === "undefined") return "bash";
    return /Win/i.test(navigator.platform) ? "powershell" : "bash";
  });

  // Only meaningful when bus is open AND we know an IP — otherwise no
  // snippets to copy.
  const reachableUrl = open && transport.url && ip ? transport.url.replace("0.0.0.0", ip) : "";
  // Two-step setup is split into TWO snippets (one copy button each)
  // so the user can pick "I already have the workspace" and skip the
  // first line.
  //   step 1: bootstrap a brAIn workspace via the published `create-brain`
  //     scaffolder — clones tibzejoker/brAIn + brAIn-store, runs pnpm
  //     install (builds @brain/sdk/core/agent + the nats binary).
  //     `--no-start` keeps it from launching the API on this remote
  //     host (only the agent CLI is needed there).
  //   step 2: run the agent against THIS broker with the env vars.
  // The CLI lives at brain/brAIn/packages/agent/dist/cli.js after the
  // scaffolder's pnpm install. Shell-specific env syntax: bash inlines
  // `KEY=val cmd`, PowerShell uses `;`-joined `$env:KEY=...` statements
  // so the whole thing stays on ONE line (much easier to copy/paste
  // into a Windows prompt than three separate statements).
  const bootstrapCmd = "npm create brain -- --no-start";
  const runCmd = ((): string => {
    if (!reachableUrl) return "";
    const url = reachableUrl;
    const tok = transport.token;
    if (shell === "powershell") {
      const parts = [`$env:BRAIN_NATS_URL="${url}"`];
      if (tok) parts.push(`$env:BRAIN_NATS_TOKEN="${tok}"`);
      parts.push("node brain/brAIn/packages/agent/dist/cli.js");
      return parts.join("; ");
    }
    const envInline = `BRAIN_NATS_URL=${url}${tok ? ` BRAIN_NATS_TOKEN=${tok}` : ""}`;
    return `${envInline} node brain/brAIn/packages/agent/dist/cli.js`;
  })();

  // Mobile join URI — `brain://join?url=...&token=...`. Parseable by the
  // Flutter mobile app's QR scanner and usable as a system deep link.
  const joinUri = reachableUrl
    ? `brain://join?url=${encodeURIComponent(reachableUrl)}${transport.token ? `&token=${encodeURIComponent(transport.token)}` : ""}`
    : "";

  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const toggleBind = useCallback((): void => {
    setError(null);
    setRestarting(true);
    setTransportBind(!open)
      .then(() => {
        // Poll until the API returns the new bind_address.
        const target = !open ? "0.0.0.0" : "127.0.0.1";
        const deadline = Date.now() + 20000;
        const poll = (): void => {
          getTransport()
            .then((t) => {
              if (t.bind_address === target) {
                setRestarting(false);
                onChanged();
              } else if (Date.now() < deadline) {
                setTimeout(poll, 500);
              } else {
                setError("API didn't restart in time — check the server logs.");
                setRestarting(false);
              }
            })
            .catch(() => {
              if (Date.now() < deadline) setTimeout(poll, 500);
              else { setError("API still down after 20s."); setRestarting(false); }
            });
        };
        setTimeout(poll, 1000);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setRestarting(false);
      });
  }, [open, onChanged]);

  return (
    <div className="px-5 py-3 border-b border-border bg-surface-raised/40 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">Broker</span>
        <code className="text-text font-mono">{transport.url ?? "—"}</code>
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
          isExternal ? "bg-node-active/10 text-node-active"
            : open ? "bg-accent/15 text-accent"
            : "bg-node-stopped/15 text-node-stopped"
        }`}>
          {isExternal ? "external" : open ? "open" : "loopback"}
        </span>
        {!isExternal && (
          <button
            onClick={toggleBind}
            disabled={restarting}
            className={`ml-auto px-2 py-0.5 text-[11px] rounded transition-colors ${
              restarting
                ? "bg-surface-overlay text-text-muted cursor-wait"
                : "bg-accent text-accent-fg hover:bg-accent/90"
            }`}
            title={open
              ? "Close the broker to LAN — only this host can connect."
              : "Open the broker to LAN — remote brain-agents can connect. Triggers an API restart."}
          >
            {restarting ? "restarting…" : open ? "Close to LAN" : "Open to LAN"}
          </button>
        )}
      </div>

      {transport.lan_ips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-text-muted">This machine:</span>
          {transport.lan_ips.map((addr) => (
            <button
              key={addr}
              onClick={() => { setPickedIp(addr); copy(`ip-${addr}`, addr); }}
              title="Copy this IP"
              className={`px-1.5 py-0.5 rounded font-mono text-[11px] transition-colors ${
                addr === ip && open
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-overlay text-text hover:bg-surface-overlay/70"
              }`}
            >
              {addr}{copied === `ip-${addr}` ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}

      {runCmd && (
        <div className="space-y-2 pt-1">
          {/* Shell picker */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-muted uppercase tracking-wider mr-1">Shell</span>
            <button
              onClick={() => setShell("bash")}
              className={`px-2 py-0.5 text-[10px] rounded ${shell === "bash" ? "bg-accent text-accent-fg" : "bg-surface-overlay text-text-muted hover:text-text"}`}
            >
              bash / zsh
            </button>
            <button
              onClick={() => setShell("powershell")}
              className={`px-2 py-0.5 text-[10px] rounded ${shell === "powershell" ? "bg-accent text-accent-fg" : "bg-surface-overlay text-text-muted hover:text-text"}`}
            >
              PowerShell
            </button>
            <span className="text-[10px] text-text-muted ml-auto">
              {shell === "powershell" ? "Windows" : "macOS / Linux"}
            </span>
          </div>

          {/* Step 1 — bootstrap */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] text-text-muted">
                <span className="inline-block w-4 h-4 mr-1 rounded-full bg-surface-overlay text-text text-[9px] leading-4 text-center font-semibold">1</span>
                Bootstrap a brAIn workspace (skip if you already have one)
              </span>
              <button
                onClick={() => copy("boot", bootstrapCmd)}
                className="text-[10px] text-text-muted hover:text-text"
              >
                {copied === "boot" ? "copied" : "copy"}
              </button>
            </div>
            <pre className="text-[11px] font-mono bg-surface-overlay px-2 py-1.5 rounded text-text whitespace-pre-wrap break-all">{bootstrapCmd}</pre>
          </div>

          {/* Step 2 — run agent */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] text-text-muted">
                <span className="inline-block w-4 h-4 mr-1 rounded-full bg-surface-overlay text-text text-[9px] leading-4 text-center font-semibold">2</span>
                Run the agent against this broker
              </span>
              <button
                onClick={() => copy("run", runCmd)}
                className="text-[10px] text-text-muted hover:text-text"
              >
                {copied === "run" ? "copied" : "copy"}
              </button>
            </div>
            <pre className="text-[11px] font-mono bg-surface-overlay px-2 py-1.5 rounded text-text whitespace-pre-wrap break-all">{runCmd}</pre>
          </div>

          <p className="text-[10px] text-text-muted">
            <code className="font-mono">create-brain</code> clones framework + marketplace + storeprojects, runs <code className="font-mono">pnpm install</code> (builds <code className="font-mono">@brain/agent</code>). The agent then auto-discovers every node type under the workspace and announces them here.
          </p>
        </div>
      )}

      {joinUri && (
        <div className="flex items-start gap-3 pt-1">
          {/* white background — QR scanners need contrast against the dark UI */}
          <div className="bg-white p-2 rounded shrink-0">
            <QRCodeSVG value={joinUri} size={120} level="M" marginSize={0} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-text-muted mb-1">
              Scan from the brAIn mobile app to join this broker.
            </p>
            <button
              onClick={() => copy("join-uri", joinUri)}
              className="text-[11px] text-text-muted hover:text-text font-mono break-all text-left"
              title="Copy the join URI"
            >
              {copied === "join-uri" ? "copied ✓" : joinUri}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[11px] text-node-stopped">{error}</p>
      )}
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
