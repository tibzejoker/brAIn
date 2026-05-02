/**
 * Per-instance state + registry helpers for mcp-config. Extracted
 * from handler.ts so the handler stays focused on message routing.
 */
import type { NodeContext } from "@brain/sdk";
import { BrainService } from "@brain/core";

export interface ChildRecord {
  nodeId: string;
  specHash: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface ManagerRuntime {
  /** alias → spawned child id + spec hash */
  children: Map<string, ChildRecord>;
  /** alias → last-seen tools list (refreshed by mcp.<alias>.status events) */
  toolCache: Map<string, ToolDescriptor[]>;
  /** Per-child status topics we've subscribed to, so we can unsubscribe on diff. */
  subscribedStatusTopics: Set<string>;
  /** True when reconcile should run on the next handler tick. */
  reconcileDirty: boolean;
  /** Whether we already applied the control-topic subscriptions for this instance. */
  controlSubsApplied: boolean;
}

export const runtimes = new Map<string, ManagerRuntime>();

export function getRt(nodeId: string): ManagerRuntime {
  let rt = runtimes.get(nodeId);
  if (!rt) {
    rt = {
      children: new Map(),
      toolCache: new Map(),
      subscribedStatusTopics: new Set(),
      reconcileDirty: true,
      controlSubsApplied: false,
    };
    runtimes.set(nodeId, rt);
  }
  return rt;
}

/**
 * Re-derive the children Map from the live registry. Source of truth
 * is "all mcp-server nodes whose `spawned_by` is this manager", not
 * our in-memory Map — that way restart amnesia (Map empty after
 * process restart) doesn't leave orphans the manager refuses to
 * touch. Each surviving child's spec hash is recomputed from its
 * persisted config_overrides so the diff against desired stays
 * accurate.
 */
export function rebuildChildrenFromRegistry(
  ctx: NodeContext,
  rt: ManagerRuntime,
  hash: (spec: Record<string, unknown>) => string,
): void {
  const brain = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!brain) return;
  const all = brain.getNetworkSnapshot({ state: "all" });
  rt.children.clear();
  for (const n of all) {
    if (n.type !== "mcp-server") continue;
    if (n.spawned_by !== ctx.node.id) continue;
    const overrides = n.config_overrides ?? {};
    const alias = typeof overrides.alias === "string" ? overrides.alias : null;
    const spec = typeof overrides.spec === "object" && overrides.spec !== null
      ? overrides.spec as Record<string, unknown>
      : null;
    if (!alias || !spec) continue;
    rt.children.set(alias, { nodeId: n.id, specHash: hash(spec) });
  }
}

/**
 * Sync our `mcp.<alias>.status` subscriptions to the current
 * children set: subscribe new aliases, unsubscribe vanished ones,
 * and prune the toolCache for aliases we no longer own.
 */
export function reconcileChildSubscriptions(ctx: NodeContext, rt: ManagerRuntime): void {
  const desired = new Set<string>();
  for (const alias of rt.children.keys()) desired.add(`mcp.${alias}.status`);
  for (const topic of rt.subscribedStatusTopics) {
    if (!desired.has(topic)) {
      ctx.unsubscribe(topic);
      rt.subscribedStatusTopics.delete(topic);
    }
  }
  for (const topic of desired) {
    if (!rt.subscribedStatusTopics.has(topic)) {
      ctx.subscribe(topic);
      rt.subscribedStatusTopics.add(topic);
    }
  }
  for (const alias of [...rt.toolCache.keys()]) {
    if (!rt.children.has(alias)) rt.toolCache.delete(alias);
  }
}
