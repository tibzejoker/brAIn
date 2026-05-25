import { useCallback, useEffect, useId, useState } from "react";
import {
  getNetworkTopics,
  bindPortTopic,
  unbindPortTopic,
} from "../api/client";
import type { PortsConfig, PortBindings, PortInputDecl, PortOutputDecl } from "@brain/sdk";

/**
 * Side-panel editor for a node's live wiring.
 *
 * Single source of truth: the node's declared ports (immutable, MCP-visible
 * contract from its config.json). For each port we render its bound topics
 * (mutable — that's the editable surface). Internal ports (no inputSchema)
 * are rendered locked/dimmed so the user can see what plumbing exists
 * without accidentally deleting framework listeners (alerts.*, time.tick).
 *
 * No flat "Subscriptions" / "Publishes" categories: the framework folds
 * every topic into the ports model at spawn time (auto-derived for nodes
 * that haven't migrated yet). The user is never asked to reason about
 * "ad-hoc subs" separately from ports.
 *
 * `onChange` fires after every successful bind/unbind so the parent
 * refetches the node snapshot — the new bindings then re-render here
 * via props rather than optimistically locally.
 */
interface WiringEditorProps {
  nodeId: string;
  /** 2-layer wiring: immutable port contract from the node's type. */
  ports?: PortsConfig;
  portBindings?: PortBindings;
  onChange: () => void;
}

export function WiringEditor({ nodeId, ports, portBindings, onChange }: WiringEditorProps): React.ReactElement {
  const [topics, setTopics] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTopics = useCallback((): void => {
    getNetworkTopics().then((r) => setTopics(r.topics)).catch(() => { /* offline-tolerant */ });
  }, []);

  useEffect(() => { loadTopics(); }, [loadTopics]);

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

  // For inputs the "internal" flag is implicit (no inputSchema = listener
  // without an MCP contract). For outputs the type author declares it
  // explicitly via `internal: true`. Either way, internal ports render
  // dimmed + locked-ish so the user sees what's wired but doesn't break
  // framework plumbing.
  const portEntries = (side: "inputs" | "outputs"): Array<[string, { description: string; internal: boolean }]> => {
    if (side === "inputs") {
      const decls = ports?.inputs;
      return decls ? Object.entries(decls).map(([k, v]: [string, PortInputDecl]) => [k, { description: v.description, internal: !v.inputSchema }]) : [];
    }
    const decls = ports?.outputs;
    return decls ? Object.entries(decls).map(([k, v]: [string, PortOutputDecl]) => [k, { description: v.description, internal: v.internal === true }]) : [];
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
  /** Each port carries an `internal` flag — true for inputs without an
   *  inputSchema (framework listeners like alerts.* / time.tick) or
   *  outputs declared `internal: true` (control signals like chat.reset). */
  ports: Array<[string, { description: string; internal: boolean }]>;
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
  // Render public ports first, internals at the bottom — same section, two
  // visual tiers. Internals still let you rewire bindings (you might want
  // alerts.* on a different topic) but the port itself is code-declared
  // and signalled with a padlock badge.
  const sorted = [...props.ports].sort(([, a], [, b]) => (a.internal ? 1 : 0) - (b.internal ? 1 : 0));
  return (
    <div>
      <div className="text-xs text-text-muted uppercase tracking-wide mb-1.5">
        {props.title} ({props.ports.length})
      </div>
      <div className="space-y-2">
        {sorted.map(([portName, decl]) => {
          const bindings = props.bindingsOf(portName);
          const draft = drafts[portName] ?? "";
          const commit = (): void => {
            if (!props.valid(draft)) return;
            void props.onBind(portName, draft);
            setDrafts((d) => ({ ...d, [portName]: "" }));
          };
          return (
            <div key={portName} className={`rounded border p-2 ${decl.internal ? "border-border/30 bg-surface-overlay/30" : "border-border/60"}`}>
              <div className="flex items-center gap-2">
                <span className={`font-mono font-semibold text-xs ${decl.internal ? "text-text-muted" : "text-text"}`}>{portName}</span>
                {decl.internal && <span className="text-text-muted opacity-60" title="Internal port — code-managed, hidden from MCP">🔒</span>}
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
