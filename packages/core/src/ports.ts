/**
 * 2-layer wiring helpers.
 *
 * Ports are the immutable "shape" of a node declared by its config.json —
 * input ports become MCP tools, output ports describe RPC replies + free
 * fan-out channels. Bindings map each port to the actual bus topics it
 * currently listens on / emits to; bindings are mutable at runtime via
 * the live-wiring API.
 *
 * Ports + default_port_bindings are the SINGLE source of truth: a node
 * MUST declare them (enforced in TypeRegistry.register). The flat
 * `default_subscriptions` / `default_publishes` lists the rest of the
 * runtime consumes are DERIVED from the ports here — the inverse of the
 * old auto-derivation, which let un-ported nodes work silently. There is
 * no such fallback any more: no ports → registration error.
 *
 * This module bridges the two layers:
 *   - {@link mergePortBindings} layers per-instance overrides on top of
 *     the type's defaults.
 *   - {@link expandPortsToSubs} turns a port-binding map into the flat
 *     SubscriptionConfig[] the bus + the dashboard already understand.
 *   - {@link publishesFromBindings} flattens the output bindings into the
 *     `default_publishes` topic list.
 *
 * Keeping the runtime side a derivation means the existing snapshot,
 * mailbox, anti-loop, MCPBridge, /tools logic all keep working without
 * needing to know about ports — they see a flat sub list as before.
 */
import {
  type SubscriptionConfig,
  type PortsConfig,
  type PortBindings,
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
 * Validate the mandatory 2-layer wiring contract. Returns the first
 * problem as a human-readable message, or `null` when the ports +
 * bindings are well-formed. Shared by TypeRegistry.register (which
 * throws) and TypeValidatorService (which reports it as a config-phase
 * failure) so static and dynamic nodes get the identical contract.
 */
export function portsConfigError(
  ports: PortsConfig | undefined,
  bindings: PortBindings | undefined,
): string | null {
  if (!ports || typeof ports !== "object") {
    return "missing required `ports` (inputs/outputs)";
  }
  if (!bindings || typeof bindings !== "object") {
    return "missing required `default_port_bindings` (port→topics)";
  }
  const inputs = ports.inputs ?? {};
  const outputs = ports.outputs ?? {};
  // Empty ports are allowed but must be DELIBERATE: a node whose wiring is
  // fully dynamic (e.g. mcp-server, which mints `mcp.<alias>.<tool>` topics
  // at runtime) declares `ports: {}` + `default_port_bindings: {}` to opt in
  // explicitly. What's forbidden is the SILENT no-ports case — caught above
  // by the missing-keys checks.
  // Every input port is a callable MCP tool → it MUST carry a JSON Schema
  // + a human description.
  for (const [portName, decl] of Object.entries(inputs)) {
    if (!decl.inputSchema || typeof decl.inputSchema !== "object") {
      return `input port "${portName}" is missing required \`inputSchema\` (JSON Schema)`;
    }
    if (!decl.description || typeof decl.description !== "string") {
      return `input port "${portName}" is missing required 'description'`;
    }
  }
  for (const [portName, decl] of Object.entries(outputs)) {
    if (!decl.description || typeof decl.description !== "string") {
      return `output port "${portName}" is missing required 'description'`;
    }
  }
  // Bindings may only reference declared ports — a stray key is a typo.
  for (const portName of Object.keys(bindings.inputs ?? {})) {
    if (!(portName in inputs)) return `default_port_bindings.inputs."${portName}" has no matching input port`;
  }
  for (const portName of Object.keys(bindings.outputs ?? {})) {
    if (!(portName in outputs)) return `default_port_bindings.outputs."${portName}" has no matching output port`;
  }
  return null;
}

/** Flatten the output side of a binding map into the unique topic list
 *  the runtime exposes as `default_publishes` (and the live-wiring
 *  publishes API reads/writes). Order-stable, de-duplicated. */
export function publishesFromBindings(bindings: PortBindings | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const topics of Object.values(bindings?.outputs ?? {})) {
    for (const t of topics) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/** Topic regex used by validators. Matches NATS subject syntax plus the
 *  `*` / `>` wildcards. */
export const TOPIC_REGEX = /^[a-zA-Z0-9._*>+-]+$/;
