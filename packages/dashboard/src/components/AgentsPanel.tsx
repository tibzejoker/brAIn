import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getAgents, getTransport, setTransportBind, joinExternalBroker, leaveExternalBroker, type AgentSnapshot, type TransportInfo } from "../api/client";
import { JoinHubModal } from "./JoinHubModal";

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
            <div className="text-text-muted/70">Pick your platform above and follow the instructions on the device you want to join.</div>
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

/** Platforms a remote bus participant can run on. macOS + Linux share
 *  the same bash snippet but get separate tabs so the user picks the
 *  one matching their device — fewer "wait does this work on me?"
 *  moments than a single "POSIX" tab. */
type Platform = "mobile" | "macos" | "linux" | "windows";

const PLATFORM_LABEL: Record<Platform, string> = {
  mobile: "Mobile",
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return "mobile";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "macos";
}

function TransportInfoView({ transport, onChanged }: {
  transport: TransportInfo;
  onChanged: () => void;
}): React.ReactElement {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const open = transport.bind_address === "0.0.0.0";
  const isExternal = transport.mode === "external";

  /** Poll the API's /network/transport endpoint until the broker mode
   *  flips to the expected target (the API has exited and respawned).
   *  Returns true on success, false on timeout. Shared helper used by
   *  both join + leave so the spinner reads the same window. */
  const pollUntilMode = useCallback(async (targetMode: "embedded" | "external"): Promise<boolean> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const t = await getTransport();
        if (t.mode === targetMode) return true;
      } catch { /* api restarting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }, []);

  const joinHub = useCallback((url: string, token: string, hubName: string): void => {
    setError(null);
    setRestarting(true);
    setJoinOpen(false);
    joinExternalBroker(url.trim(), token.trim() || undefined, hubName.trim() || undefined)
      .then(async (r) => {
        if (!r.restart_scheduled) { setRestarting(false); onChanged(); return; }
        const ok = await pollUntilMode("external");
        if (!ok) setError("API didn't come back in time — check the broker URL/token.");
        setRestarting(false);
        onChanged();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setRestarting(false);
      });
  }, [onChanged, pollUntilMode]);

  const leaveHub = useCallback((): void => {
    setError(null);
    setRestarting(true);
    leaveExternalBroker()
      .then(async (r) => {
        if (!r.restart_scheduled) { setRestarting(false); onChanged(); return; }
        const ok = await pollUntilMode("embedded");
        if (!ok) setError("API didn't come back in time.");
        setRestarting(false);
        onChanged();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setRestarting(false);
      });
  }, [onChanged, pollUntilMode]);

  const toggleBind = useCallback((): void => {
    setError(null);
    setRestarting(true);
    setTransportBind(!open)
      .then(() => {
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
    <div className="border-b border-border bg-surface-raised/40">
      <BrokerHeader
        transport={transport}
        open={open}
        isExternal={isExternal}
        restarting={restarting}
        onJoinClick={() => setJoinOpen(true)}
        onLeaveClick={leaveHub}
        onToggleBindClick={toggleBind}
      />

      {open && !isExternal && (
        <InviteSection
          transport={transport}
          platform={platform}
          onPlatformChange={setPlatform}
        />
      )}

      {error && (
        <p className="px-5 pb-3 text-[11px] text-node-stopped">{error}</p>
      )}

      {joinOpen && (
        <JoinHubModal
          onCancel={() => setJoinOpen(false)}
          onSubmit={joinHub}
        />
      )}
    </div>
  );
}

/** Top row of the panel: broker URL, mode badge, primary actions. */
function BrokerHeader({ transport, open, isExternal, restarting, onJoinClick, onLeaveClick, onToggleBindClick }: {
  transport: TransportInfo;
  open: boolean;
  isExternal: boolean;
  restarting: boolean;
  onJoinClick: () => void;
  onLeaveClick: () => void;
  onToggleBindClick: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-xs max-w-2xl mx-auto w-full">
      <span className="text-text-muted">Broker</span>
      <code className="text-text font-mono">{transport.url ?? "—"}</code>
      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
        isExternal ? "bg-node-active/10 text-node-active"
          : open ? "bg-accent/15 text-accent"
          : "bg-node-stopped/15 text-node-stopped"
      }`}>
        {isExternal
          ? (transport.joined_hub ? `joined: ${transport.joined_hub.hubName ?? "hub"}` : "external")
          : open ? "open" : "loopback"}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {isExternal && transport.joined_hub && (
          <button
            onClick={onLeaveClick}
            disabled={restarting}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
              restarting
                ? "bg-surface-overlay text-text-muted cursor-wait"
                : "bg-surface-overlay text-text hover:bg-border"
            }`}
            title="Drop the persisted external-broker config and restart in embedded mode."
          >
            {restarting ? "restarting…" : "Disconnect"}
          </button>
        )}
        {!isExternal && (
          <>
            <button
              onClick={onJoinClick}
              disabled={restarting}
              className="px-2 py-0.5 text-[11px] rounded bg-surface-overlay text-text hover:bg-border transition-colors"
              title="Join an existing brAIn hub via its broker URL + token. The local API will restart in external mode."
            >
              Join hub…
            </button>
            <button
              onClick={onToggleBindClick}
              disabled={restarting}
              className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
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
          </>
        )}
      </div>
    </div>
  );
}

/** "Invite a new node" section. Picks one platform at a time so the
 *  user only sees the instructions that apply to their device. */
function InviteSection({ transport, platform, onPlatformChange }: {
  transport: TransportInfo;
  platform: Platform;
  onPlatformChange: (p: Platform) => void;
}): React.ReactElement | null {
  const [pickedIp, setPickedIp] = useState<string | null>(null);
  const ip = pickedIp ?? (transport.lan_ips.length > 0 ? transport.lan_ips[0] : "");
  const reachableUrl = transport.url && ip ? transport.url.replace("0.0.0.0", ip) : "";

  if (!reachableUrl) {
    return (
      <p className="px-5 pb-4 text-[11px] text-text-muted">
        No LAN address detected — connect this machine to a network to invite remote nodes.
      </p>
    );
  }

  // max-w-2xl keeps the snippet/QR section a comfortable reading width
  // on wide monitors instead of stretching across the whole right pane;
  // mx-auto keeps it centered inside the panel.
  return (
    <div className="px-5 pb-4 space-y-3 max-w-2xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Invite a node</span>
        <div className="flex gap-1">
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
            <button
              key={p}
              onClick={() => onPlatformChange(p)}
              className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                platform === p
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-overlay text-text-muted hover:text-text"
              }`}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {transport.lan_ips.length > 1 && (
        <LanIpPicker ips={transport.lan_ips} pickedIp={ip} onPick={setPickedIp} />
      )}

      {platform === "mobile"
        ? <MobileInstructions reachableUrl={reachableUrl} token={transport.token} />
        : <DesktopInstructions platform={platform} reachableUrl={reachableUrl} token={transport.token} />}
    </div>
  );
}

function LanIpPicker({ ips, pickedIp, onPick }: {
  ips: string[];
  pickedIp: string;
  onPick: (ip: string) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-text-muted">From IP:</span>
      {ips.map((addr) => (
        <button
          key={addr}
          onClick={() => onPick(addr)}
          title="Use this LAN IP in the snippet"
          className={`px-1.5 py-0.5 rounded font-mono text-[11px] transition-colors ${
            addr === pickedIp
              ? "bg-accent/15 text-accent"
              : "bg-surface-overlay text-text hover:bg-surface-overlay/70"
          }`}
        >
          {addr}
        </button>
      ))}
    </div>
  );
}

function MobileInstructions({ reachableUrl, token }: {
  reachableUrl: string;
  token: string | null;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
  const joinUri = `brain://join?url=${encodeURIComponent(reachableUrl)}${tokenQuery}`;
  const copy = (): void => {
    void navigator.clipboard.writeText(joinUri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-3">
      <div className="bg-white p-2 rounded shrink-0">
        <QRCodeSVG value={joinUri} size={128} level="M" marginSize={0} />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-[11px] text-text">Scan from the brAIn mobile app.</p>
        <p className="text-[10px] text-text-muted">The phone joins this broker and exposes its sensors as a passive bus client.</p>
        <button
          onClick={copy}
          className="text-[10px] text-text-muted hover:text-text font-mono break-all text-left max-w-full"
          title="Copy the join URI"
        >
          {copied ? "copied ✓" : joinUri}
        </button>
      </div>
    </div>
  );
}

function DesktopInstructions({ platform, reachableUrl, token }: {
  platform: Exclude<Platform, "mobile">;
  reachableUrl: string;
  token: string | null;
}): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  // `npm create brain` clones framework + marketplace + storeprojects,
  // installs deps (which builds @brain/agent). `--no-start` keeps it
  // from launching its own API on the remote — we only need the agent
  // CLI there. Step 2 then runs that CLI against THIS broker.
  const bootstrapCmd = "npm create brain -- --no-start";
  const runCmd = useMemo(() => {
    const tok = token;
    if (platform === "windows") {
      const parts = [`$env:BRAIN_NATS_URL="${reachableUrl}"`];
      if (tok) parts.push(`$env:BRAIN_NATS_TOKEN="${tok}"`);
      parts.push("node brain/brAIn/packages/agent/dist/cli.js");
      return parts.join("; ");
    }
    const tokenSuffix = tok ? ` BRAIN_NATS_TOKEN=${tok}` : "";
    return `BRAIN_NATS_URL=${reachableUrl}${tokenSuffix} node brain/brAIn/packages/agent/dist/cli.js`;
  }, [platform, reachableUrl, token]);

  return (
    <div className="space-y-2">
      <Snippet
        step={1}
        label="Bootstrap a brAIn workspace (skip if you already have one)"
        cmd={bootstrapCmd}
        copied={copied === "boot"}
        onCopy={() => copy("boot", bootstrapCmd)}
      />
      <Snippet
        step={2}
        label="Run the agent against this broker"
        cmd={runCmd}
        copied={copied === "run"}
        onCopy={() => copy("run", runCmd)}
      />
      <p className="text-[10px] text-text-muted">
        The agent auto-discovers every node type under the workspace and announces them here.
      </p>
    </div>
  );
}

function Snippet({ step, label, cmd, copied, onCopy }: {
  step: number;
  label: string;
  cmd: string;
  copied: boolean;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-text-muted">
          <span className="inline-block w-4 h-4 mr-1 rounded-full bg-surface-overlay text-text text-[9px] leading-4 text-center font-semibold">{step}</span>
          {label}
        </span>
        <button onClick={onCopy} className="text-[10px] text-text-muted hover:text-text">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="text-[11px] font-mono bg-surface-overlay px-2 py-1.5 rounded text-text whitespace-pre-wrap break-all">{cmd}</pre>
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
