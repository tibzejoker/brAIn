import {
  type NodeInfo,
  type NodeHandler,
  type NodeModule,
  type NodeOnSpawn,
  type NodeTeardown,
  type NodeInstanceConfig,
  type RunMode,
  NodeState,
} from "@brain/sdk";
import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { saveNode, saveSubscription, deleteNode } from "./db";
import { createRunner, type BaseRunner, type SleepService } from "./runner";
import type { IBusService } from "./bus";
import type { TypeRegistry, InstanceRegistry } from "./registry";
import type { AuthorityService } from "./authority";
import { dispatchRemoteSpawn, dispatchRemoteAction } from "./brain-remote";
import type { LLMRegistry } from "./llm/llm-registry";
import type { LLMConfigStore } from "./llm/llm-config";

type HandlerLoader = (typeName: string, typePath: string) => Promise<NodeModule>;

export interface LifecycleDeps {
  db: Database.Database;
  bus: IBusService;
  typeRegistry: TypeRegistry;
  instanceRegistry: InstanceRegistry;
  authority: AuthorityService;
  sleepService: SleepService;
  runners: Map<string, BaseRunner>;
  globalRunMode: RunMode;
  loadHandler: HandlerLoader;
  /**
   * Maps remote-spawned node ids to the agent currently hosting them.
   * Populated when a remote spawn dispatches; consulted by killNode to
   * route the kill request to the right agent.
   */
  remoteNodes: Map<string, string>;
  /** Forwarded into every runner so `ctx.llm.*` resolves models against
   *  the live registry + config. */
  llmRegistry?: LLMRegistry;
  llmConfig?: LLMConfigStore;
}

export async function spawnNode(
  deps: LifecycleDeps,
  config: NodeInstanceConfig,
  callerNodeId?: string,
): Promise<NodeInfo> {
  if (callerNodeId) {
    const caller = deps.instanceRegistry.get(callerNodeId);
    if (!caller) throw new Error(`Caller node ${callerNodeId} not found`);
    if (!deps.authority.canPerform(caller, "spawn_node")) {
      throw new Error("Insufficient authority to spawn nodes");
    }
    const maxAuth = deps.authority.getMaxChildAuthority(caller);
    if (config.authority_level !== undefined && config.authority_level > maxAuth) {
      throw new Error(`Cannot spawn with authority ${config.authority_level}, max: ${maxAuth}`);
    }
  }

  // Remote dispatch: when the caller asks for `transport: "remote"`,
  // we don't load handler / create runner / save in DB locally. We
  // publish a spawn-request on `brain.agents.<target_agent_id>.spawn`
  // and let the agent host the actual instance. The API tracks the
  // mapping so a later DELETE can route to the right agent.
  if (config.transport === "remote") {
    return dispatchRemoteSpawn(deps, config, callerNodeId);
  }

  const typeConfig = deps.typeRegistry.get(config.type);
  if (!typeConfig) throw new Error(`Unknown node type: ${config.type}`);

  const typePath = deps.typeRegistry.getPath(config.type);
  if (!typePath) throw new Error(`No path for type: ${config.type}`);

  // Web nodes have no local JS module — they live behind an HTTP/WS service.
  // The runner factory dispatches to WebRunner when transport === "web", so
  // we provide a no-op stub here. Resolve the web config from the type
  // (default), letting per-instance config_overrides.web take precedence.
  const transport = config.transport ?? (typeConfig.web ? "web" : "process");
  const isWeb = transport === "web";
  let handler: NodeHandler;
  let teardown: NodeTeardown | undefined;
  let onSpawn: NodeOnSpawn | undefined;
  if (isWeb) {
    handler = (): Promise<void> => Promise.resolve();
  } else {
    const mod = await deps.loadHandler(config.type, typePath);
    handler = mod.handler;
    teardown = mod.teardown;
    onSpawn = mod.onSpawn;
  }
  const mergedOverrides: Record<string, unknown> = { ...(config.config_overrides ?? {}) };
  if (isWeb && !mergedOverrides.web && typeConfig.web) {
    mergedOverrides.web = typeConfig.web;
  }

  const nodeInfo: NodeInfo = {
    id: config.id ?? uuid(),
    type: config.type,
    name: config.name,
    description: config.description ?? typeConfig.description,
    tags: config.tags ?? typeConfig.tags,
    authority_level: config.authority_level ?? typeConfig.default_authority,
    state: NodeState.ACTIVE,
    priority: config.priority ?? typeConfig.default_priority,
    subscriptions: config.subscriptions ?? typeConfig.default_subscriptions,
    transport,
    position: config.position ?? { x: 0, y: 0 },
    config_overrides: mergedOverrides,
    default_publishes: typeConfig.default_publishes,
    spawned_by: callerNodeId,
    ttl: config.ttl ? deps.sleepService.parseInterval(config.ttl) : undefined,
    created_at: Date.now(),
  };

  saveNode(deps.db, {
    id: nodeInfo.id,
    type: nodeInfo.type,
    name: nodeInfo.name,
    description: nodeInfo.description,
    tags: JSON.stringify(nodeInfo.tags),
    authority_level: nodeInfo.authority_level,
    priority: nodeInfo.priority,
    transport: nodeInfo.transport,
    config_overrides: JSON.stringify(config.config_overrides ?? {}),
    position_x: nodeInfo.position.x,
    position_y: nodeInfo.position.y,
    spawned_by: nodeInfo.spawned_by ?? null,
    created_at: nodeInfo.created_at,
  });

  for (const sub of nodeInfo.subscriptions) {
    saveSubscription(deps.db, {
      node_id: nodeInfo.id,
      topic: sub.topic,
      // `description` is declared NOT NULL DEFAULT '' on the column,
      // but better-sqlite3 binds an undefined JS value as NULL (not as
      // "use the default"), which trips the constraint. Coerce to ""
      // here so the default really is empty-string when the caller
      // hasn't supplied one.
      description: sub.description ?? "",
      input_schema: sub.inputSchema ? JSON.stringify(sub.inputSchema) : null,
      min_criticality: sub.min_criticality ?? null,
      mailbox_max_size: sub.mailbox?.max_size ?? 100,
      mailbox_retention: sub.mailbox?.retention ?? "latest",
    });
  }

  deps.instanceRegistry.add(nodeInfo);

  for (const sub of nodeInfo.subscriptions) {
    deps.bus.subscribe(nodeInfo.id, sub.topic, { mailbox: sub.mailbox });
  }

  const runner = createRunner(
    nodeInfo,
    handler,
    {
      bus: deps.bus, registry: deps.instanceRegistry, sleepService: deps.sleepService,
      spawnNode: (c, caller) => spawnNode(deps, c, caller),
      killNode: (id, caller, reason) => killNode(deps, id, caller, reason),
      llmRegistry: deps.llmRegistry,
      llmConfig: deps.llmConfig,
    },
    deps.globalRunMode,
    teardown,
    onSpawn,
  );
  deps.runners.set(nodeInfo.id, runner);

  if (config.initial_message) {
    deps.bus.publish({
      from: "system",
      topic: `node.${nodeInfo.id}.init`,
      type: "text",
      criticality: 5,
      payload: { content: config.initial_message },
    });
  }

  if (nodeInfo.ttl) {
    setTimeout(() => {
      killNode(deps, nodeInfo.id, undefined, "TTL expired");
    }, nodeInfo.ttl);
  }

  runner.start();

  return nodeInfo;
}

export function killNode(
  deps: LifecycleDeps,
  nodeId: string,
  callerNodeId?: string,
  reason?: string,
): boolean {
  // Route remote nodes through NATS — the API never owned a runner
  // for them, so there's nothing local to stop.
  const remoteAgent = deps.remoteNodes.get(nodeId);
  if (remoteAgent) {
    deps.bus.publish({
      from: callerNodeId ?? "system.api",
      topic: `brain.agents.${remoteAgent}.kill`,
      type: "text",
      criticality: 5,
      payload: { content: JSON.stringify({ node_id: nodeId, reason }) },
      metadata: { node_id: nodeId, agent_id: remoteAgent, reason },
    });
    deps.remoteNodes.delete(nodeId);
    deps.instanceRegistry.remove(nodeId);
    return true;
  }

  const node = deps.instanceRegistry.get(nodeId);
  if (!node) return false;

  if (callerNodeId) {
    const caller = deps.instanceRegistry.get(callerNodeId);
    if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
    if (!deps.authority.canPerform(caller, "kill_node", node)) {
      throw new Error("Insufficient authority to kill this node");
    }
  }

  const runner = deps.runners.get(nodeId);
  if (runner) {
    runner.stop();
    deps.runners.delete(nodeId);
  }

  deps.bus.removeAllSubscriptions(nodeId);
  deps.instanceRegistry.updateState(nodeId, NodeState.TERMINATED);
  deps.instanceRegistry.remove(nodeId);
  deleteNode(deps.db, nodeId);

  return true;
}

export function stopNode(
  deps: LifecycleDeps,
  nodeId: string,
  callerNodeId?: string,
  _reason?: string,
  bufferMessages = false,
): boolean {
  if (dispatchRemoteAction(deps, nodeId, "stop", callerNodeId)) return true;

  const node = deps.instanceRegistry.get(nodeId);
  if (!node) return false;

  if (callerNodeId) {
    const caller = deps.instanceRegistry.get(callerNodeId);
    if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
    if (!deps.authority.canPerform(caller, "stop_node", node)) {
      throw new Error("Insufficient authority to stop this node");
    }
  }

  const runner = deps.runners.get(nodeId);
  if (runner) runner.stop();
  if (!bufferMessages) deps.bus.removeAllSubscriptions(nodeId);
  deps.instanceRegistry.updateState(nodeId, NodeState.STOPPED);
  return true;
}

export async function startNode(
  deps: LifecycleDeps,
  nodeId: string,
  callerNodeId?: string,
  message?: string,
): Promise<boolean> {
  if (dispatchRemoteAction(deps, nodeId, "start", callerNodeId, message)) return true;

  const node = deps.instanceRegistry.get(nodeId);
  if (!node || node.state !== NodeState.STOPPED) return false;

  if (callerNodeId) {
    const caller = deps.instanceRegistry.get(callerNodeId);
    if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
    if (!deps.authority.canPerform(caller, "start_node", node)) {
      throw new Error("Insufficient authority to start this node");
    }
  }

  const typePath = deps.typeRegistry.getPath(node.type);
  if (!typePath) return false;

  const { handler, teardown, onSpawn } = await deps.loadHandler(node.type, typePath);

  const runner = createRunner(
    node, handler,
    {
      bus: deps.bus, registry: deps.instanceRegistry, sleepService: deps.sleepService,
      spawnNode: (c, caller) => spawnNode(deps, c, caller),
      killNode: (id, caller, reason) => killNode(deps, id, caller, reason),
      llmRegistry: deps.llmRegistry,
      llmConfig: deps.llmConfig,
    },
    deps.globalRunMode,
    teardown,
    onSpawn,
  );
  deps.runners.set(nodeId, runner);

  for (const sub of node.subscriptions) {
    deps.bus.subscribe(nodeId, sub.topic, { mailbox: sub.mailbox });
  }

  if (message) {
    deps.bus.publish({
      from: "system", topic: `node.${nodeId}.restart`,
      type: "text", criticality: 5, payload: { content: message },
    });
  }

  runner.start();

  return true;
}

export function wakeNode(
  deps: LifecycleDeps,
  nodeId: string,
  callerNodeId?: string,
  message?: string,
): boolean {
  if (dispatchRemoteAction(deps, nodeId, "wake", callerNodeId, message)) return true;

  const node = deps.instanceRegistry.get(nodeId);
  if (!node || node.state !== NodeState.SLEEPING) return false;

  if (callerNodeId) {
    const caller = deps.instanceRegistry.get(callerNodeId);
    if (!caller) throw new Error(`Caller not found: ${callerNodeId}`);
    if (!deps.authority.canPerform(caller, "wake_node", node)) {
      throw new Error("Insufficient authority to wake this node");
    }
  }

  if (message) {
    deps.bus.publish({
      from: callerNodeId ?? "system", topic: `node.${nodeId}.wake`,
      type: "text", criticality: 5, payload: { content: message },
    });
  }

  deps.sleepService.wake(nodeId);
  return true;
}

