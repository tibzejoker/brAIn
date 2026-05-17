import { useState, useCallback, useEffect, useMemo } from "react";
import type { NodeTypeConfig, NodeSnapshot } from "../api/types";
import { spawnNode, getAgents, type AgentSnapshot } from "../api/client";
import { Group, TypeRow, Empty } from "./NodeCreatorBits";

/** Picker selection. agentId=null → local; otherwise → remote spawn. */
interface Selection {
  type: string;
  agentId: string | null;
}

interface NodeCreatorProps {
  types: NodeTypeConfig[];
  nodes: NodeSnapshot[];
  open: boolean;
  onClose: () => void;
  onSpawned: () => void;
}

export function NodeCreator({
  types,
  nodes,
  open,
  onClose,
  onSpawned,
}: NodeCreatorProps): React.ReactElement | null {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [name, setName] = useState("");
  const [subscriptions, setSubscriptions] = useState("");
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open + fetch live agent list.
  useEffect(() => {
    if (!open) return;
    setSelection(null);
    setName("");
    setSubscriptions("");
    setError(null);
    setCollapsed(new Set());

    let cancelled = false;
    getAgents()
      .then((list) => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return (): void => { cancelled = true; };
  }, [open]);

  // Pre-fill name + subscriptions from the type's defaults whenever the
  // selection changes. Existing-count is per type so the auto-name
  // (e.g. "chat-3") doesn't collide.
  useEffect(() => {
    if (!selection) return;
    const typeConfig = types.find((t) => t.name === selection.type);
    if (!typeConfig) return;
    const sameType = nodes.filter((n) => n.type === selection.type).length;
    setName(`${typeConfig.name}-${sameType + 1}`);
    setSubscriptions(typeConfig.default_subscriptions.map((s) => s.topic).join(", "));
  }, [selection, types, nodes]);

  const handleSubmit = useCallback((): void => {
    if (!selection || !name) return;

    // Spawn-time overrides via the wizard only let the user paste topic
    // names — there's no UI to author a JSON Schema. Treat each as an
    // internal listener so the framework's discipline isn't violated.
    // For schema-carrying public subs, declare them in the node's
    // config.json instead.
    const subs = subscriptions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((topic) => ({ topic, description: topic, internal: true as const }));

    setLoading(true);
    setError(null);

    spawnNode({
      type: selection.type,
      name,
      subscriptions: subs.length > 0 ? subs : undefined,
      ...(selection.agentId
        ? { transport: "remote", target_agent_id: selection.agentId }
        : {}),
    })
      .then(() => { onSpawned(); onClose(); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [selection, name, subscriptions, onSpawned, onClose]);

  // Per-type running counts. For local nodes we count rows whose
  // transport is not "remote"; for an agent we match target_agent_id.
  const localCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const n of nodes) {
      if (n.transport === "remote") continue;
      out[n.type] = (out[n.type] ?? 0) + 1;
    }
    return out;
  }, [nodes]);

  const remoteCounts = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const n of nodes) {
      if (n.transport !== "remote") continue;
      const a = (n as { target_agent_id?: string }).target_agent_id;
      if (!a) continue;
      const bucket = out[a] ?? (out[a] = {});
      bucket[n.type] = (bucket[n.type] ?? 0) + 1;
    }
    return out;
  }, [nodes]);

  const toggle = (key: string): void => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  if (!open) return null;

  const hasSelection = selection !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border rounded-lg w-[560px] max-h-[80vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">Spawn Node</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Selection panel — sticky top, only useful once a type is picked */}
        <div className={`border-b border-border px-5 py-3 shrink-0 transition-colors ${hasSelection ? "bg-surface-overlay/40" : "bg-surface/40"}`}>
          {hasSelection ? (
            <>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] text-text-muted">Type</span>
                <code className="text-sm text-accent font-mono">{selection.type}</code>
                <span className="text-[11px] text-text-muted ml-auto">
                  on {selection.agentId
                    ? agents.find((a) => a.agent_id === selection.agentId)?.host ?? "remote"
                    : "Local"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-node"
                    className="w-full px-2 py-1.5 rounded bg-surface-overlay border border-border text-text text-xs focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">
                    Subscriptions <span className="text-text-muted/60">(comma-separated)</span>
                  </label>
                  <input
                    type="text"
                    value={subscriptions}
                    onChange={(e) => setSubscriptions(e.target.value)}
                    placeholder="time.*, alerts.*"
                    className="w-full px-2 py-1.5 rounded bg-surface-overlay border border-border text-text text-xs focus:outline-none focus:border-accent"
                  />
                </div>
              </div>
              {selection.agentId && (
                <p className="mt-2 text-[11px] text-text-muted">
                  Will spawn via NATS as <code className="text-text">transport: "remote"</code>.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-text-muted italic">Pick a type below to configure the spawn.</p>
          )}
        </div>

        {/* Targets list — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3 min-h-0">
          {/* LOCAL */}
          <Group
            label="Local"
            sublabel="this brAIn process"
            count={types.length}
            isCollapsed={collapsed.has("local")}
            onToggle={() => toggle("local")}
          >
            {types.length === 0 ? (
              <Empty>No node types registered.</Empty>
            ) : (
              types.map((t) => (
                <TypeRow
                  key={t.name}
                  name={t.name}
                  description={t.description}
                  running={localCounts[t.name] ?? 0}
                  selected={selection?.type === t.name && selection.agentId === null}
                  onClick={() => setSelection({ type: t.name, agentId: null })}
                />
              ))
            )}
          </Group>

          {/* REMOTES */}
          {agents.map((a) => {
            const buckets = remoteCounts[a.agent_id] ?? {};
            const count = a.types.length;
            const id = `agent-${a.agent_id}`;
            return (
              <Group
                key={a.agent_id}
                label={a.host}
                sublabel={`${a.agent_id}`}
                count={count}
                isCollapsed={collapsed.has(id)}
                onToggle={() => toggle(id)}
              >
                {count === 0 ? (
                  <Empty>This remote announces no installable types — it's a passive bus client (e.g. brAIn-mobile). Publish to its topics directly instead of spawning here.</Empty>
                ) : (
                  a.types.map((typeName) => {
                    const tc = types.find((t) => t.name === typeName);
                    return (
                      <TypeRow
                        key={typeName}
                        name={typeName}
                        description={tc?.description ?? "(remote-only type)"}
                        running={buckets[typeName] ?? 0}
                        selected={selection?.type === typeName && selection.agentId === a.agent_id}
                        onClick={() => setSelection({ type: typeName, agentId: a.agent_id })}
                      />
                    );
                  })
                )}
              </Group>
            );
          })}

          {agents.length === 0 && (
            <p className="text-[11px] text-text-muted italic px-1">
              No remote agents connected. Open the Distributed pane to invite some.
            </p>
          )}
        </div>

        {error && (
          <div className="text-xs text-node-stopped bg-node-stopped/10 px-5 py-2 border-t border-border">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-muted hover:text-text rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !selection || !name}
            className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-accent-fg hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {loading ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  );
}

