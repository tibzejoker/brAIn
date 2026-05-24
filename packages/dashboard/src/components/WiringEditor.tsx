import { useCallback, useEffect, useId, useState } from "react";
import {
  addNodeSubscription,
  removeNodeSubscription,
  addNodePublish,
  removeNodePublish,
  getNetworkTopics,
  bindPortTopic,
  unbindPortTopic,
} from "../api/client";
import type { PortsConfig, PortBindings } from "@brain/sdk";

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
  /** 2-layer wiring: immutable port contract from the node's type. When
   *  present, the editor renders a "Ports" section above the legacy flat
   *  lists, with bindings (topic ↔ port) as the only editable surface. */
  ports?: PortsConfig;
  portBindings?: PortBindings;
  onChange: () => void;
}

export function WiringEditor({ nodeId, subscriptions, publishes, ports, portBindings, onChange }: WiringEditorProps): React.ReactElement {
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

  // 2-layer wiring — port bindings (mutable) on top of immutable ports.
  const handleBindPort = useCallback(async (side: "inputs" | "outputs", portName: string, topic: string): Promise<void> => {
    if (!topic.trim()) return;
    setBusy(`port-${side}-${portName}-bind`); setError(null);
    try { await bindPortTopic(nodeId, side, portName, topic.trim()); onChange(); loadTopics(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, onChange, loadTopics]);
  const handleUnbindPort = useCallback(async (side: "inputs" | "outputs", portName: string, topic: string): Promise<void> => {
    setBusy(`port-${side}-${portName}-${topic}-rm`); setError(null);
    try { await unbindPortTopic(nodeId, side, portName, topic); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [nodeId, onChange]);

  const valid = (s: string): boolean => /^[a-zA-Z0-9._*>+-]+$/.test(s.trim());
  const subPlaceholder = "topic to subscribe to (e.g. chat.input)";
  const pubPlaceholder = "topic to publish on (e.g. my.event)";

  const portEntries = (side: "inputs" | "outputs"): Array<[string, { description: string }]> => {
    const decls = side === "inputs" ? ports?.inputs : ports?.outputs;
    return decls ? Object.entries(decls).map(([k, v]) => [k, { description: v.description }]) : [];
  };
  const bindingsOf = (side: "inputs" | "outputs", portName: string): string[] => {
    const m = side === "inputs" ? portBindings?.inputs : portBindings?.outputs;
    return m?.[portName] ?? [];
  };

  return (
    <div className="space-y-4 text-sm">
      {/* === 2-layer: PORTS (immutable contract) =================== */}
      {ports && (ports.inputs || ports.outputs) && (
        <PortSection
          title="Input ports"
          ports={portEntries("inputs")}
          bindingsOf={(p) => bindingsOf("inputs", p)}
          topics={topics}
          valid={valid}
          busyKey={busy ?? ""}
          onBind={(p, t) => handleBindPort("inputs", p, t)}
          onUnbind={(p, t) => handleUnbindPort("inputs", p, t)}
          inputPlaceholder="topic to bind (e.g. chat.input)"
        />
      )}
      {ports?.outputs && (
        <PortSection
          title="Output ports"
          ports={portEntries("outputs")}
          bindingsOf={(p) => bindingsOf("outputs", p)}
          topics={topics}
          valid={(s) => valid(s) && !/[*>]/.test(s.trim())}
          busyKey={busy ?? ""}
          onBind={(p, t) => handleBindPort("outputs", p, t)}
          onUnbind={(p, t) => handleUnbindPort("outputs", p, t)}
          inputPlaceholder="topic to publish on (no wildcards)"
        />
      )}

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

/**
 * One section in the side panel rendering either Input ports or Output
 * ports. Each declared port shows its name + description + the list of
 * currently bound topics (with ✕ to remove). Below: input + add button
 * for binding a new topic to this port. The port itself can't be removed —
 * it comes from the node type's code.
 */
function PortSection(props: {
  title: string;
  ports: Array<[string, { description: string }]>;
  bindingsOf: (port: string) => string[];
  topics: string[];
  valid: (s: string) => boolean;
  busyKey: string;
  onBind: (port: string, topic: string) => void | Promise<void>;
  onUnbind: (port: string, topic: string) => void | Promise<void>;
  inputPlaceholder: string;
}): React.ReactElement | null {
  const datalistId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (props.ports.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-text-muted uppercase tracking-wide mb-1.5">
        {props.title} ({props.ports.length})
      </div>
      <div className="space-y-2">
        {props.ports.map(([portName, decl]) => {
          const bindings = props.bindingsOf(portName);
          const draft = drafts[portName] ?? "";
          const commit = (): void => {
            if (!props.valid(draft)) return;
            void props.onBind(portName, draft);
            setDrafts((d) => ({ ...d, [portName]: "" }));
          };
          return (
            <div key={portName} className="rounded border border-border/60 p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-text font-semibold text-xs">{portName}</span>
                <span className="text-[10px] text-text-muted truncate">{decl.description}</span>
              </div>
              {bindings.length === 0 ? (
                <div className="mt-1 text-[10px] italic text-text-muted">orphan — no topic wired yet</div>
              ) : (
                <div className="mt-1 space-y-0.5">
                  {bindings.map((topic) => (
                    <div key={topic} className="flex items-center gap-2 px-1 py-0.5 rounded bg-surface-overlay">
                      <span className="flex-1 font-mono text-[11px] truncate text-text">{topic}</span>
                      <button
                        type="button"
                        onClick={() => { void props.onUnbind(portName, topic); }}
                        disabled={props.busyKey === `port-${portName}-${topic}-rm`}
                        title="Unbind this topic from the port"
                        className="text-text-muted hover:text-node-stopped text-xs leading-none disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1 mt-1">
                <input
                  list={datalistId}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [portName]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                  placeholder={props.inputPlaceholder}
                  className="flex-1 bg-bg border border-border rounded px-2 py-0.5 font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={commit}
                  disabled={!props.valid(draft)}
                  className="px-1.5 py-0.5 rounded bg-surface-overlay border border-border text-xs hover:bg-elevated disabled:opacity-40"
                  title="Bind topic to this port"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <datalist id={datalistId}>
        {props.topics.map((t) => <option key={t} value={t} />)}
      </datalist>
    </div>
  );
}
