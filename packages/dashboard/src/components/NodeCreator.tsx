import { useState, useCallback, useEffect } from "react";
import type { NodeTypeConfig } from "../api/types";
import { spawnNode, getAgents, type AgentSnapshot } from "../api/client";

const LOCAL_TARGET = "local";

interface NodeCreatorProps {
  types: NodeTypeConfig[];
  existingNodeCount: number;
  open: boolean;
  onClose: () => void;
  onSpawned: () => void;
}

export function NodeCreator({
  types,
  existingNodeCount,
  open,
  onClose,
  onSpawned,
}: NodeCreatorProps): React.ReactElement | null {
  const [selectedType, setSelectedType] = useState("");
  const [name, setName] = useState("");
  const [subscriptions, setSubscriptions] = useState("");
  const [target, setTarget] = useState<string>(LOCAL_TARGET);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill name and subscriptions when type changes
  useEffect(() => {
    const typeConfig = types.find((t) => t.name === selectedType);
    if (!typeConfig) return;

    setName(`${typeConfig.name}-${existingNodeCount + 1}`);

    const defaultSubs = typeConfig.default_subscriptions
      .map((s) => s.topic)
      .join(", ");
    setSubscriptions(defaultSubs);
  }, [selectedType, types, existingNodeCount]);

  // Reset form + fetch live agents whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setSelectedType("");
    setName("");
    setSubscriptions("");
    setTarget(LOCAL_TARGET);
    setError(null);

    let cancelled = false;
    getAgents()
      .then((list) => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return (): void => { cancelled = true; };
  }, [open]);

  const handleSubmit = useCallback((): void => {
    if (!selectedType || !name) return;

    const subs = subscriptions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((topic) => ({ topic }));

    setLoading(true);
    setError(null);

    const remote = target !== LOCAL_TARGET;
    spawnNode({
      type: selectedType,
      name,
      subscriptions: subs.length > 0 ? subs : undefined,
      ...(remote ? { transport: "remote", target_agent_id: target } : {}),
    })
      .then(() => {
        onSpawned();
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [selectedType, name, subscriptions, target, onSpawned, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border rounded-lg w-[420px] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text">Spawn Node</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Type</label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-overlay border border-border text-text text-sm focus:outline-none focus:border-accent"
            >
              <option value="">Select a type...</option>
              {types.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-node"
              className="w-full px-3 py-2 rounded-md bg-surface-overlay border border-border text-text text-sm focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">
              Subscriptions (comma-separated topics)
            </label>
            <input
              type="text"
              value={subscriptions}
              onChange={(e) => setSubscriptions(e.target.value)}
              placeholder="time.*, alerts.*"
              className="w-full px-3 py-2 rounded-md bg-surface-overlay border border-border text-text text-sm focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">
              Target {agents.length > 0 && (
                <span className="text-text-muted/70">
                  · {agents.length} agent{agents.length > 1 ? "s" : ""} online
                </span>
              )}
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-overlay border border-border text-text text-sm focus:outline-none focus:border-accent"
            >
              <option value={LOCAL_TARGET}>Local (this brAIn process)</option>
              {agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.host} · {a.agent_id}
                </option>
              ))}
            </select>
            {target !== LOCAL_TARGET && (
              <p className="mt-1 text-[11px] text-text-muted">
                Spawned via NATS as <code className="text-text">transport: "remote"</code>.
                The agent must register the type locally.
              </p>
            )}
          </div>

          {error && (
            <div className="text-xs text-node-stopped bg-node-stopped/10 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-muted hover:text-text rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !selectedType || !name}
            className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {loading ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  );
}
