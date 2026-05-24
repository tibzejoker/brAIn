import { useCallback, useEffect, useId, useState } from "react";
import {
  addNodeSubscription,
  removeNodeSubscription,
  addNodePublish,
  removeNodePublish,
  getNetworkTopics,
} from "../api/client";

/**
 * Side-panel editor for a node's live wiring — subscriptions (typed inputs)
 * and publishes (declared outputs). Each list has:
 *   - a row per current entry with an ✕ to remove
 *   - an input + datalist auto-completed from the merged network's known
 *     topics, plus a + button to commit
 *
 * The component is dumb about local vs peer-owned — the backend routes
 * transparently via the brain.agents.<hub>.update_{subscriptions,publishes}
 * channel when the node lives elsewhere. We just call the HTTP endpoints
 * and trust the round-trip.
 *
 * `onChange` is invoked after every successful mutation so the parent can
 * refetch the node's snapshot. We DON'T optimistically update locally —
 * letting the snapshot be the source of truth keeps the merge view honest
 * (especially when a peer's snapshot also lands on the same tick).
 */
interface WiringEditorProps {
  nodeId: string;
  subscriptions: Array<{ id: string; pattern: string }>;
  publishes: string[];
  onChange: () => void;
}

export function WiringEditor({ nodeId, subscriptions, publishes, onChange }: WiringEditorProps): React.ReactElement {
  const [topics, setTopics] = useState<string[]>([]);
  const [subDraft, setSubDraft] = useState("");
  const [pubDraft, setPubDraft] = useState("");
  const [busy, setBusy] = useState<null | "sub-add" | "pub-add" | string>(null);
  const [error, setError] = useState<string | null>(null);
  const subListId = useId();
  const pubListId = useId();

  const loadTopics = useCallback((): void => {
    getNetworkTopics().then((r) => setTopics(r.topics)).catch(() => { /* offline-tolerant */ });
  }, []);

  useEffect(() => { loadTopics(); }, [loadTopics]);

  const handleAddSub = useCallback(async (): Promise<void> => {
    const topic = subDraft.trim();
    if (!topic) return;
    setBusy("sub-add"); setError(null);
    try {
      await addNodeSubscription(nodeId, { topic, internal: true });
      setSubDraft("");
      onChange();
      loadTopics();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, subDraft, onChange, loadTopics]);

  const handleRemoveSub = useCallback(async (topic: string): Promise<void> => {
    setBusy(`sub-rm-${topic}`); setError(null);
    try { await removeNodeSubscription(nodeId, topic); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, onChange]);

  const handleAddPub = useCallback(async (): Promise<void> => {
    const topic = pubDraft.trim();
    if (!topic) return;
    setBusy("pub-add"); setError(null);
    try {
      await addNodePublish(nodeId, topic);
      setPubDraft("");
      onChange();
      loadTopics();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, pubDraft, onChange, loadTopics]);

  const handleRemovePub = useCallback(async (topic: string): Promise<void> => {
    setBusy(`pub-rm-${topic}`); setError(null);
    try { await removeNodePublish(nodeId, topic); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, onChange]);

  const valid = (s: string): boolean => /^[a-zA-Z0-9._*>+-]+$/.test(s.trim());
  const subPlaceholder = "topic to subscribe to (e.g. chat.input)";
  const pubPlaceholder = "topic to publish on (e.g. my.event)";

  return (
    <div className="space-y-4 text-sm">
      {/* Subscriptions — typed inputs. Each is an MCP-style port: the
          declared inputSchema (when public) makes it a discoverable tool.
          Click ✕ to remove, type + Enter / + to add. */}
      <div>
        <div className="text-xs text-text-muted uppercase tracking-wide mb-1.5">
          Subscriptions ({subscriptions.length})
        </div>
        <div className="space-y-1">
          {subscriptions.length === 0 && (
            <div className="text-xs text-text-muted italic">No subscriptions — this node receives nothing yet.</div>
          )}
          {subscriptions.map((sub) => (
            <div key={sub.id} className="flex items-center gap-2 px-2 py-1 rounded bg-surface-overlay">
              <span className="flex-1 text-xs font-mono truncate text-text">{sub.pattern}</span>
              <button
                type="button"
                onClick={() => { void handleRemoveSub(sub.pattern); }}
                disabled={busy === `sub-rm-${sub.pattern}`}
                title="Remove subscription"
                className="text-text-muted hover:text-node-stopped text-sm leading-none disabled:opacity-40"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <input
            list={subListId}
            value={subDraft}
            onChange={(e) => setSubDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid(subDraft)) void handleAddSub(); }}
            placeholder={subPlaceholder}
            className="flex-1 bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => { void handleAddSub(); }}
            disabled={busy === "sub-add" || !valid(subDraft)}
            className="px-2 py-1 rounded bg-surface-overlay border border-border text-xs hover:bg-elevated disabled:opacity-40"
            title="Add subscription (internal listener)"
          >
            +
          </button>
        </div>
      </div>

      {/* Publishes — declared output topics. The node is free to publish on
          anything at runtime (ctx.publish takes any string), but declaring
          here makes the topic visible in the graph + discoverable. */}
      <div>
        <div className="text-xs text-text-muted uppercase tracking-wide mb-1.5">
          Publishes ({publishes.length})
        </div>
        <div className="space-y-1">
          {publishes.length === 0 && (
            <div className="text-xs text-text-muted italic">No declared publishes.</div>
          )}
          {publishes.map((topic) => (
            <div key={topic} className="flex items-center gap-2 px-2 py-1 rounded bg-surface-overlay">
              <span className="flex-1 text-xs font-mono truncate text-text">{topic}</span>
              <button
                type="button"
                onClick={() => { void handleRemovePub(topic); }}
                disabled={busy === `pub-rm-${topic}`}
                title="Remove publish"
                className="text-text-muted hover:text-node-stopped text-sm leading-none disabled:opacity-40"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <input
            list={pubListId}
            value={pubDraft}
            onChange={(e) => setPubDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid(pubDraft)) void handleAddPub(); }}
            placeholder={pubPlaceholder}
            className="flex-1 bg-bg border border-border rounded px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => { void handleAddPub(); }}
            disabled={busy === "pub-add" || !valid(pubDraft)}
            className="px-2 py-1 rounded bg-surface-overlay border border-border text-xs hover:bg-elevated disabled:opacity-40"
            title="Add publish"
          >
            +
          </button>
        </div>
      </div>

      {/* Shared datalist — same topic universe feeds both inputs. The
          datalist is browser-native: typing filters, picking commits. */}
      <datalist id={subListId}>
        {topics.map((t) => <option key={t} value={t} />)}
      </datalist>
      <datalist id={pubListId}>
        {topics.map((t) => <option key={t} value={t} />)}
      </datalist>

      {error && (
        <div className="text-xs text-node-stopped px-2 py-1 rounded bg-node-stopped/10">
          {error}
        </div>
      )}
    </div>
  );
}
