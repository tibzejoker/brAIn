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
      // Every input port is callable by design — emit a public sub with
      // the declared schema. No more "internal" tier: if a port exists,
      // any node (or MCP client) can publish on its bound topics. Authors
      // who want truly hidden plumbing simply don't declare it as a port.
      out.push({
        topic,
        description: `[port:${portName}] ${decl.description}`,
        inputSchema: decl.inputSchema,
        outputSchema: decl.outputSchema,
      });
    }
  }
  return out;
}

/**
 * Backward-compat: when a node type didn't migrate to the ports model,
 * synthesize a {@link PortsConfig} from its existing default subs. Each
 * sub becomes an input port — including ones declared `internal:true`,
 * which get a permissive `{ type: "object" }` schema so they remain
 * callable (consistent with the simplified "every port is callable" model).
 */
export function autoDerivePorts(
  subs: SubscriptionConfig[],
  publishes: string[] | undefined,
): PortsConfig {
  const inputs: Record<string, PortInputDecl> = {};
  // Every sub becomes a callable port. Subs declared `internal:true`
  // without an explicit schema get a permissive `{ type: "object" }`
  // so the port is still callable — any node can in principle invoke
  // the listener (e.g. publish on `chat.reset` to force a brain wipe).
  // "Internal" wasn't really a security boundary, just a tagging hint
  // that we've dropped in favour of the simpler all-ports-are-callable
  // model. Public subs keep their declared schema.
  const PERMISSIVE: Record<string, unknown> = { type: "object" };
  for (const s of subs) {
    inputs[s.topic] = {
      description: s.description,
      inputSchema: s.inputSchema ?? PERMISSIVE,
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
  // Every sub becomes a port bound to its own topic. Auto-derived ports
  // are equivalent regardless of whether the original sub was tagged
  // internal — the bus still needs the binding so subscriptions are
  // actually wired up.
  for (const s of subs) inputs[s.topic] = [s.topic];
  const outputs: Record<string, string[]> = {};
  for (const t of publishes ?? []) outputs[t] = [t];
  return { inputs, outputs };
}

/** Topic regex used by validators. Matches NATS subject syntax plus the
 *  `*` / `>` wildcards. */
export const TOPIC_REGEX = /^[a-zA-Z0-9._*>+-]+$/;
