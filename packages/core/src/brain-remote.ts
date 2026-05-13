/**
 * Remote control helpers.
 *
 * The lifecycle module stays focused on the local path; this file
 * holds the bus-dispatch glue used when `transport: "remote"`. The
 * API publishes a `brain.agents.<id>.<action>` request and tracks
 * the `node_id → agent_id` mapping so later actions route back.
 *
 * The API also keeps a stub of every remote node in its
 * `instanceRegistry` so the dashboard's network snapshot includes
 * them. The stub is updated optimistically when control actions
 * succeed at the dispatch layer — the agent's announcements +
 * future state-change topic will keep the two sides in sync.
 */
import { v4 as uuid } from "uuid";
import { NodeState, type NodeInfo, type NodeInstanceConfig, normaliseSubscription } from "@brain/sdk";
import type { LifecycleDeps } from "./brain-lifecycle";

export type RemoteAction = "stop" | "start" | "wake";

export function dispatchRemoteSpawn(
  deps: LifecycleDeps,
  config: NodeInstanceConfig,
  callerNodeId?: string,
): NodeInfo {
  const agentId = config.target_agent_id;
  if (!agentId) throw new Error("transport=remote requires target_agent_id");

  const id = config.id ?? uuid();
  const typeConfig = deps.typeRegistry.get(config.type);

  // The API may not have the type registered locally if it was added
  // dynamically on the agent — fall back to whatever the caller gave.
  const stub: NodeInfo = {
    id,
    type: config.type,
    name: config.name,
    description: config.description ?? typeConfig?.description ?? config.type,
    tags: config.tags ?? typeConfig?.tags ?? [],
    authority_level: config.authority_level ?? typeConfig?.default_authority ?? 0,
    state: NodeState.ACTIVE,
    priority: config.priority ?? typeConfig?.default_priority ?? 1,
    subscriptions: (config.subscriptions ?? typeConfig?.default_subscriptions ?? []).map(normaliseSubscription),
    transport: "remote",
    target_agent_id: agentId,
    position: config.position ?? { x: 0, y: 0 },
    config_overrides: config.config_overrides,
    default_publishes: typeConfig?.default_publishes,
    spawned_by: callerNodeId,
    created_at: Date.now(),
  };

  const request = { id, agent_id: agentId, config: { ...config, id } };
  deps.bus.publish({
    from: "system.api",
    topic: `brain.agents.${agentId}.spawn`,
    type: "text",
    criticality: 3,
    payload: { content: JSON.stringify(request) },
    metadata: request as unknown as Record<string, unknown>,
  });

  deps.remoteNodes.set(id, agentId);
  // Register the stub locally so /network includes the remote node.
  deps.instanceRegistry.add(stub);
  return stub;
}

/**
 * Returns true when the action was dispatched (the node is remote).
 * Returns false when the node isn't tracked as remote — the caller
 * should fall through to the local path.
 *
 * Optimistically updates the local stub's state so the dashboard
 * reflects the requested change immediately. The agent is the source
 * of truth and may later flip the state via its own announcements.
 */
export function dispatchRemoteAction(
  deps: LifecycleDeps,
  nodeId: string,
  action: RemoteAction,
  callerNodeId?: string,
  message?: string,
): boolean {
  const agentId = deps.remoteNodes.get(nodeId);
  if (!agentId) return false;

  const payload = { node_id: nodeId, message };
  deps.bus.publish({
    from: callerNodeId ?? "system.api",
    topic: `brain.agents.${agentId}.${action}`,
    type: "text",
    criticality: 3,
    payload: { content: JSON.stringify(payload) },
    metadata: { node_id: nodeId, agent_id: agentId, action },
  });

  // Optimistic local-state update. The mapping mirrors the local
  // lifecycle: stop → STOPPED, start/wake → ACTIVE.
  const nextState = action === "stop" ? NodeState.STOPPED : NodeState.ACTIVE;
  deps.instanceRegistry.updateState(nodeId, nextState);
  return true;
}
