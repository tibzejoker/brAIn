import { useCallback, useEffect, useMemo, useState } from "react";
import { patchNodeConfig, sendToNode, getMessages } from "../api/client";

/**
 * Per-instance MCP server config editor for an mcp-host node.
 *
 * The shape stored in `config_overrides.mcpServers` follows the
 * Claude Desktop / Cursor / Cline standard:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *       },
 *       "linear": {
 *         "url": "https://mcp.linear.app/mcp",
 *         "headers": { "Authorization": "Bearer ${env:LINEAR_API_KEY}" }
 *       }
 *     }
 *   }
 *
 * The panel parses that map, lists each server with its detected
 * transport + endpoint, lets the user edit the JSON directly,
 * Save → PATCH /nodes/:id/config (the API publishes
 * `mcp.host.reload` when `mcpServers` is in the patch, so the
 * node reconciles connections without a respawn).
 *
 * Multiple mcp-host instances are independent: each panel reads
 * and writes its own node's `config_overrides`.
 */
interface MCPPanelProps {
  nodeId: string;
  configOverrides: Record<string, unknown>;
  onChanged: () => void;
}

interface ServerSummary {
  name: string;
  transport: "stdio" | "http" | "sse" | "ws";
  endpoint: string;
  raw: Record<string, unknown>;
}

interface ServerStatus {
  name: string;
  status: "connected" | "error" | "pending";
  toolCount?: number;
  error?: string;
}

function summarize(name: string, raw: Record<string, unknown>): ServerSummary | null {
  const cmd = typeof raw.command === "string" ? raw.command : undefined;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const explicit = (raw.transport ?? raw.type) as string | undefined;
  let transport: ServerSummary["transport"];
  if (explicit === "stdio") transport = "stdio";
  else if (explicit === "sse") transport = "sse";
  else if (explicit === "ws" || explicit === "websocket") transport = "ws";
  else if (explicit === "http" || explicit === "streamable-http") transport = "http";
  else if (cmd) transport = "stdio";
  else if (url) transport = "http";
  else return null;
  const endpoint = transport === "stdio"
    ? `${cmd ?? "?"} ${(raw.args as string[] | undefined)?.join(" ") ?? ""}`.trim()
    : (url ?? "?");
  return { name, transport, endpoint, raw };
}

function readServers(overrides: Record<string, unknown>): ServerSummary[] {
  const out: ServerSummary[] = [];
  const map = overrides.mcpServers;
  if (typeof map === "object" && map !== null && !Array.isArray(map)) {
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const s = summarize(name, raw as Record<string, unknown>);
      if (s) out.push(s);
    }
  }
  // Legacy `servers: [{name, …}]` form, kept for back-compat.
  const arr = overrides.servers;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== "string") continue;
      const s = summarize(r.name, r);
      if (s) out.push(s);
    }
  }
  return out;
}

function transportTone(t: ServerSummary["transport"]): string {
  if (t === "stdio") return "bg-node-active/20 text-node-active";
  if (t === "http") return "bg-accent/20 text-accent";
  if (t === "sse") return "bg-node-sleeping/20 text-node-sleeping";
  return "bg-surface-overlay text-text-muted";
}

const DEFAULT_TEMPLATE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}`;

export function MCPPanel({ nodeId, configOverrides, onChanged }: MCPPanelProps): React.ReactElement {
  // Local override of the source-of-truth so saving immediately
  // reflects in the UI (deletes disappear, adds show up) without
  // waiting for the parent's network refresh to round-trip.
  const [localOverrides, setLocalOverrides] = useState<Record<string, unknown> | null>(null);
  const effectiveOverrides = localOverrides ?? configOverrides;

  // When the parent's config matches our local override (refresh
  // caught up), drop the override so we trust the parent again.
  useEffect(() => {
    if (localOverrides
        && JSON.stringify(localOverrides.mcpServers) === JSON.stringify(configOverrides.mcpServers)) {
      setLocalOverrides(null);
    }
  }, [configOverrides, localOverrides]);

  const servers = useMemo(() => readServers(effectiveOverrides), [effectiveOverrides]);

  const [statuses, setStatuses] = useState<Record<string, ServerStatus | undefined>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Poll mcp.host.status from this node every 2 s — the host
  // re-publishes after each reconcile so we get connected/error
  // state including the SDK's underlying error message.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        if (cancelled) return;
        const msgs = await getMessages({ topic: "mcp.host.status", last: 50 });
        if (cancelled as boolean) return;
        const fromThis = msgs.filter((m) => m.from === nodeId);
        if (fromThis.length === 0) return;
        const latest = fromThis[fromThis.length - 1];
        const meta = latest.metadata as { servers?: Array<{ name: string; status: "connected" | "error"; toolCount?: number; error?: string }> } | undefined;
        if (!meta?.servers) return;
        const next: Record<string, ServerStatus | undefined> = {};
        for (const s of meta.servers) {
          next[s.name] = { name: s.name, status: s.status, toolCount: s.toolCount, error: s.error };
        }
        setStatuses(next);
      } catch { /* silent — periodic poll */ }
    };
    void refresh();
    // Also publish a status request so we get an immediate status
    // even without a recent reconcile.
    void sendToNode(nodeId, "mcp.host.status.request", "").catch(() => { /* may be filtered by anti-loop, the periodic refresh still works */ });
    const iv = setInterval(refresh, 2000);
    return (): void => { cancelled = true; clearInterval(iv); };
  }, [nodeId]);

  const openEditor = useCallback((): void => {
    const initial = effectiveOverrides.mcpServers ?? effectiveOverrides.servers ?? {};
    setDraft(JSON.stringify({ mcpServers: initial }, null, 2));
    setError(null);
    setEditing(true);
  }, [effectiveOverrides]);

  const cancelEdit = useCallback((): void => {
    setEditing(false);
    setError(null);
  }, []);

  const useTemplate = useCallback((): void => {
    setDraft(DEFAULT_TEMPLATE);
    setError(null);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      const map = parsed.mcpServers;
      if (typeof map !== "object" || map === null || Array.isArray(map)) {
        throw new Error('expected `mcpServers` to be an object');
      }
      // Patch — also clear any legacy `servers` array so the new
      // shape wins cleanly. `null` deletes a key per the API contract.
      const res = await patchNodeConfig(nodeId, { mcpServers: map, servers: null });
      // Optimistic local update so the UI reflects deletes / adds
      // before the parent's network refresh round-trips.
      setLocalOverrides(res.config_overrides);
      // Drop stale statuses for servers that are no longer in the
      // config — they'll be re-populated by the next reconcile poll.
      setStatuses((prev) => {
        const wantedNames = new Set(Object.keys(map));
        const next: Record<string, ServerStatus | undefined> = {};
        for (const [k, v] of Object.entries(prev)) if (wantedNames.has(k)) next[k] = v;
        return next;
      });
      setEditing(false);
      setSavedAt(Date.now());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, nodeId, onChanged]);

  // Auto-fade the "Saved" notice
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 4000);
    return (): void => { clearTimeout(t); };
  }, [savedAt]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {!editing && (
        <>
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-xs text-text-muted uppercase tracking-wide">
              {servers.length === 0 ? "No MCP servers configured" : `${servers.length} MCP server${servers.length > 1 ? "s" : ""}`}
            </span>
            <button
              onClick={openEditor}
              className="px-2 py-1 text-[11px] rounded bg-accent/20 text-accent hover:bg-accent/30"
            >
              {servers.length === 0 ? "+ Add" : "Edit"}
            </button>
          </div>

          {servers.length === 0 && (
            <div className="text-text-muted text-xs py-4 px-2">
              Click <span className="text-text">Edit</span> to paste a Claude Desktop-style
              <code className="text-text mx-1">mcpServers</code> map. Each server entry
              auto-discriminates: <code className="text-text">command</code> → stdio,
              <code className="text-text mx-1">url</code> → Streamable HTTP (or SSE / WS
              with an explicit <code className="text-text">type</code>).
            </div>
          )}

          {servers.map((s) => {
            const st = statuses[s.name];
            const dotColor =
              st?.status === "connected" ? "bg-node-active" :
              st?.status === "error"     ? "bg-node-stopped" :
                                           "bg-text-muted/40";
            return (
              <div key={s.name} className="py-2 px-1 border-b border-border/30 last:border-0">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${dotColor}`} title={st?.status ?? "pending"} />
                  <span className="text-sm font-medium text-text">{s.name}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] rounded font-mono ${transportTone(s.transport)}`}>
                    {s.transport}
                  </span>
                  {st?.status === "connected" && (
                    <span className="text-[10px] text-text-muted ml-auto">
                      {st.toolCount ?? 0} tool{(st.toolCount ?? 0) > 1 ? "s" : ""}
                    </span>
                  )}
                  {st?.status === "error" && (
                    <span className="text-[10px] text-node-stopped ml-auto font-semibold">error</span>
                  )}
                </div>
                <p className="text-[11px] text-text-muted font-mono mt-0.5 break-all">
                  {s.endpoint}
                </p>
                {st?.status === "error" && st.error && (
                  <p className="text-[11px] text-node-stopped font-mono mt-1 break-words bg-node-stopped/10 rounded px-2 py-1">
                    {st.error}
                  </p>
                )}
              </div>
            );
          })}

          {savedAt !== null && (
            <div className="mt-3 px-2 py-1 text-[11px] text-node-active bg-node-active/10 rounded">
              Saved · the node reloaded its connections
            </div>
          )}
        </>
      )}

      {editing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-text-muted">JSON config</span>
            <button
              onClick={useTemplate}
              className="text-[11px] text-text-muted hover:text-text"
            >
              Insert template
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-72 px-2 py-2 rounded bg-surface-overlay border border-border text-text text-[11px] font-mono focus:outline-none focus:border-accent"
          />
          {error && (
            <div className="text-[11px] text-node-stopped bg-node-stopped/10 rounded px-2 py-1">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="px-3 py-1 text-xs text-text-muted hover:text-text rounded"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save & reload"}
            </button>
          </div>
          <p className="text-[10px] text-text-muted px-1">
            Bearer tokens etc. — use <code className="text-text">${"${env:VAR}"}</code> to
            avoid storing secrets in the JSON. The node expands them at connect time.
          </p>
        </div>
      )}
    </div>
  );
}
