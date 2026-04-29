/**
 * Remote-spawn helpers.
 *
 * The lifecycle module stays focused on the local path; this file
 * holds the bus-dispatch glue used when `transport: "remote"`. The
 * API publishes a `brain.agents.<id>.spawn` request and tracks the
 * `node_id → agent_id` mapping so a later kill can be routed back.
 *
 * Killing remote nodes is symmetric — published as
 * `brain.agents.<id>.kill` and handled directly in `killNode`, so
 * this file's job is just the spawn dispatch + the synthetic
 * NodeInfo needed to keep the API caller's contract.
 */
import { v4 as uuid } from "uuid";
import { NodeState, type NodeInfo, type NodeInstanceConfig } from "@brain/sdk";
import type { LifecycleDeps } from "./brain-lifecycle";

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
    subscriptions: config.subscriptions ?? typeConfig?.default_subscriptions ?? [],
    transport: "remote",
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
  return stub;
}
