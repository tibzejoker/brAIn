/**
 * 2-layer wiring helpers.
 *
 * Ports are the immutable "shape" of a node declared by its config.json —
 * input ports become MCP tools, output ports describe RPC replies + free
 * fan-out channels. Bindings map each port to the actual bus topics it
 * currently listens on / emits to; bindings are mutable at runtime via
 * the live-wiring API.
 *
 * This module bridges the two layers:
 *   - {@link mergePortBindings} layers per-instance overrides on top of
 *     the type's defaults.
 *   - {@link expandPortsToSubs} turns a port-binding map into the flat
 *     SubscriptionConfig[] the bus + the dashboard already understand.
 *   - {@link autoDerivePorts} / {@link autoDeriveBindings} provide
 *     backward compat for nodes that haven't migrated to the ports model:
 *     every public default_subscription becomes a port named by its topic.
 *
 * Keeping the runtime side a derivation means the existing snapshot,
 * mailbox, anti-loop, MCPBridge, /tools logic all keep working without
 * needing to know about ports — they see a flat sub list as before.
 */
import {
  type SubscriptionConfig,
  type PortsConfig,
  type PortBindings,
  type PortInputDecl,
  type PortOutputDecl,
} from "@brain/sdk";

export function mergePortBindings(
  base: PortBindings | undefined,
  override: PortBindings | undefined,
): PortBindings {
  if (!base && !override) return {};
  return {
    inputs: { ...(base?.inputs ?? {}), ...(override?.inputs ?? {}) },
    outputs: { ...(base?.outputs ?? {}), ...(override?.outputs ?? {}) },
  };
}

/** Walk every (input port, bound topic) pair and emit one SubscriptionConfig
 *  per topic. The schema comes from the port declaration so the bus picks
 *  up the right shape for publish-time validation + /tools surfacing. */
export function expandPortsToSubs(
  ports: PortsConfig | undefined,
  bindings: PortBindings | undefined,
): SubscriptionConfig[] {
  if (!ports?.inputs || !bindings?.inputs) return [];
  const out: SubscriptionConfig[] = [];
  for (const [portName, decl] of Object.entries(ports.inputs)) {
    const topics = bindings.inputs[portName] ?? [];
    for (const topic of topics) {
      // Ports without inputSchema are internal listeners — emit them as
      // internal subs so the bus + dashboard treat them as such. Ports with
      // an inputSchema are public tools (the discriminated union requires
      // `internal: false` to be omitted, so we just spread the schema).
      const base = {
        topic,
        description: `[port:${portName}] ${decl.description}`,
        outputSchema: decl.outputSchema,
      };
      if (decl.inputSchema) {
        out.push({ ...base, inputSchema: decl.inputSchema });
      } else {
        out.push({ ...base, internal: true });
      }
    }
  }
  return out;
}

/**
 * Backward-compat: when a node type didn't migrate to the ports model,
 * synthesize a {@link PortsConfig} from its existing public subs. Each
 * public sub (non-internal, has inputSchema) becomes an input port named
 * by its topic. Internal subs stay out — they're the "Internal listeners"
 * compartment, not the public surface.
 */
export function autoDerivePorts(
  subs: SubscriptionConfig[],
  publishes: string[] | undefined,
): PortsConfig {
  const inputs: Record<string, PortInputDecl> = {};
  for (const s of subs) {
    // Every sub becomes a port. Public ones carry their inputSchema
    // (which makes them MCP tools); internal ones are inputSchema-less
    // listeners (alerts, time.tick, signals) — hidden from /mcp but still
    // editable as port bindings in the dashboard.
    inputs[s.topic] = {
      description: s.description,
      inputSchema: s.internal === true ? undefined : s.inputSchema,
      outputSchema: s.outputSchema,
    };
  }
  const outputs: Record<string, PortOutputDecl> = {};
  for (const t of publishes ?? []) {
    outputs[t] = { description: t };
  }
  return { inputs, outputs };
}

/** Companion to {@link autoDerivePorts}: each derived port is bound to
 *  its own topic by default — the synthesised "natural" wiring. */
export function autoDeriveBindings(
  subs: SubscriptionConfig[],
  publishes: string[] | undefined,
): PortBindings {
  const inputs: Record<string, string[]> = {};
  // Every sub becomes a port bound to its own topic — including internal
  // ones (alerts.*, time.tick…). The dashboard renders internals dimmed
  // but they still need bindings so the bus actually subscribes.
  for (const s of subs) inputs[s.topic] = [s.topic];
  const outputs: Record<string, string[]> = {};
  for (const t of publishes ?? []) outputs[t] = [t];
  return { inputs, outputs };
}

/** Topic regex used by validators. Matches NATS subject syntax plus the
 *  `*` / `>` wildcards. */
export const TOPIC_REGEX = /^[a-zA-Z0-9._*>+-]+$/;
