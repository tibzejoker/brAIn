/**
 * Builds the per-iteration NodeContext handed to a node's handler.
 *
 * Extracted from base-runner so the runner stays under the 300-line
 * lint cap and the context surface is reviewable in isolation.
 *
 * The handler-facing surface is intentionally narrow: bus IO, lifecycle
 * (spawn/kill — auth-gated), state, and a few stubs that concrete
 * runners override (LLM, tools, files). There is no `sleep` — the
 * framework parks a node automatically after its handler returns and
 * wakes it on the next subscribed message. Periodic work subscribes
 * to a tick topic from `clock` / `cron`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type NodeContext, type NodeInfo, type NodeInstanceConfig, type Message,
  type ReadMessagesOptions, type MailboxConfig, type LLMRequest, type LLMResponse,
  type LLMFacade as ILLMFacade,
  type FileOpts, type FileRef, type FileContent, type FileFilter, type FileInfo,
  type PreemptionContext, type SubscriptionConfig,
  type ToolsFacade, type ToolDescriptor,
  type SkillsFacade, type SkillInfo, type SkillContent,
  normaliseSubscription,
} from "@brain/sdk";
import type { IBusService } from "../bus/bus.interface";
import { SKILLS_SEARCH_SUBJECT, SKILLS_LOAD_SUBJECT, SKILLS_SAVE_SUBJECT, SKILLS_DELETE_SUBJECT, SKILLS_LIST_SUBJECT } from "../skills";
import type { NodeLog } from "./node-log";
import { LLMFacade } from "../llm/llm-facade";
import type { LLMRegistry } from "../llm/llm-registry";
import type { LLMConfigStore } from "../llm/llm-config";
import { toolDescriptorsForNode } from "../mcp/tool-catalog";

/**
 * Root under which every node's per-instance dataDir lives. Set at
 * boot (see `BrainService.bootstrap`); falls back to `<cwd>/data/nodes`
 * so unit tests and quick scripts work without explicit wiring.
 */
let DATA_ROOT = path.resolve(process.cwd(), "data", "nodes");

export function setNodeDataRoot(absPath: string): void {
  DATA_ROOT = path.resolve(absPath);
}

export function getNodeDataRoot(): string {
  return DATA_ROOT;
}

export interface BuildContextDeps {
  bus: IBusService;
  spawnNode?: (c: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killNode?: (id: string, caller?: string, reason?: string) => boolean;
  /** Optional — when present, ctx.llm.* uses the real registry/config.
   *  When absent (older test scaffolding), ctx.llm becomes a stub that
   *  throws a clear error so the missing dep is obvious. */
  llmRegistry?: LLMRegistry;
  llmConfig?: LLMConfigStore;
  /** Live instance registry — powers `ctx.tools.list()` so the LLM
   *  can discover every public subscription on the network. */
  instanceRegistry?: { list(): NodeInfo[] };
  /** Peer hubs' nodes (other machines on the bus), already tagged with
   *  `owner_hub`. Merged into `ctx.tools.list()` so the consciousness is
   *  aware of — and can invoke — remote nodes. Invocation is just a bus
   *  publish on the node's topic, which NATS delivers cross-machine, so
   *  discovery is the only thing the local registry was missing. */
  peerNodes?: () => NodeInfo[];
}

export interface BuildContextRuntime {
  nodeInfo: NodeInfo;
  state: Record<string, unknown>;
  log: NodeLog;
  iteration: number;
}

export function buildNodeContext(
  rt: BuildContextRuntime,
  deps: BuildContextDeps,
  messages: Message[],
  signal: AbortSignal,
  preemption: PreemptionContext | null,
): NodeContext {
  const nodeId = rt.nodeInfo.id;
  const bus = deps.bus;
  const log = rt.log;

  // 2-layer wiring tag: build a reverse index `topic → port` from the
  // node's input bindings so each delivered message can be stamped with
  // its arriving port. Lets handlers switch on `msg.port` instead of
  // `msg.topic` — wiring changes don't require rewriting the handler.
  const topicToPort = new Map<string, string>();
  for (const [portName, topics] of Object.entries(rt.nodeInfo.port_bindings?.inputs ?? {})) {
    for (const t of topics) topicToPort.set(t, portName);
  }
  const taggedMessages = topicToPort.size === 0
    ? messages
    : messages.map((m) => {
        const p = topicToPort.get(m.topic);
        return p && m.port === undefined ? { ...m, port: p } : m;
      });

  // Resolve response topic: config override > default_publishes[0].
  const responseTopic = (rt.nodeInfo.config_overrides?.response_topic as string | undefined)
    ?? rt.nodeInfo.default_publishes?.[0]
    ?? "";

  // Causal-trace inheritance: when the handler publishes during an
  // iteration, fold in the trace_id of one of the messages it's
  // processing as `parent_id`. The bus then inherits trace_id from
  // that parent. We pick the first message's id for stability —
  // handlers fanning out to many topics still share one trace.
  const parentId = messages.length > 0 ? messages[0].id : undefined;

  return {
    messages: taggedMessages,
    readMessages: (opts?: ReadMessagesOptions): Message[] => bus.readMessages(nodeId, opts),
    respond(content: string, metadata?: Record<string, unknown>): void {
      if (!responseTopic) {
        log.error("respond() called but no response_topic configured");
        return;
      }
      log.info(`respond → ${responseTopic}`);
      bus.publish({
        from: nodeId, topic: responseTopic,
        type: "text", criticality: 1,
        payload: { content }, metadata, parent_id: parentId,
      });
    },
    publish(topic: string, msg: Omit<Message, "id" | "from" | "timestamp" | "topic">): void {
      log.info(`publish ${topic} (crit:${msg.criticality})`);
      bus.publish({ ...msg, from: nodeId, topic, parent_id: msg.parent_id ?? parentId });
    },
    emit_port(portName: string, msg: Omit<Message, "id" | "from" | "timestamp" | "topic">): void {
      // Fan-out over the topics currently wired to the named OUTPUT port.
      // No-op + warn when the port isn't declared on this node or has zero
      // bindings — quietly silent emissions would hide misconfiguration.
      const topics = rt.nodeInfo.port_bindings?.outputs?.[portName] ?? [];
      const portDecl = rt.nodeInfo.ports?.outputs?.[portName];
      if (!portDecl) {
        log.warn(`emit_port: '${portName}' is not declared on this node type — emission dropped`);
        return;
      }
      if (topics.length === 0) {
        log.warn(`emit_port: port '${portName}' is orphan (zero bindings) — emission dropped`);
        return;
      }
      for (const topic of topics) {
        log.info(`emit_port ${portName} → ${topic}`);
        bus.publish({ ...msg, from: nodeId, topic, parent_id: msg.parent_id ?? parentId });
      }
    },
    subscribe(
      topic: string,
      opts?:
        | { description: string; inputSchema: Record<string, unknown>; mailbox?: Partial<MailboxConfig>; internal?: false }
        | { internal: true; description?: string; mailbox?: Partial<MailboxConfig> },
    ): void {
      log.info(`+ subscribe ${topic}`);
      bus.subscribe(nodeId, topic, { mailbox: opts?.mailbox });
      // No opts at all → pure bus listener, not surfaced as a tool. Same
      // pre-discriminated-union semantics, just no hidden description.
      if (!opts) return;
      // Runtime guard — the TS types already forbid this combination at
      // compile time, but JS callers (tests, dynamic agents) can still
      // get here with malformed opts. Fail loud.
      const optsLoose = opts as { internal?: unknown; inputSchema?: unknown };
      const isInternal = optsLoose.internal === true;
      const hasSchema = optsLoose.inputSchema !== undefined && optsLoose.inputSchema !== null;
      if (!isInternal && !hasSchema) {
        throw new Error(`ctx.subscribe("${topic}"): non-internal subscriptions must declare an inputSchema. Mark { internal: true } if this is private plumbing.`);
      }
      const entry: SubscriptionConfig = normaliseSubscription({
        topic,
        description: opts.description,
        inputSchema: "inputSchema" in opts ? opts.inputSchema : undefined,
        mailbox: opts.mailbox,
        internal: "internal" in opts ? opts.internal : false,
      });
      const existing = rt.nodeInfo.subscriptions.findIndex((s) => s.topic === topic);
      if (existing >= 0) rt.nodeInfo.subscriptions[existing] = entry;
      else rt.nodeInfo.subscriptions.push(entry);
    },
    unsubscribe: (topic: string): void => {
      bus.unsubscribe(nodeId, topic);
      const i = rt.nodeInfo.subscriptions.findIndex((s) => s.topic === topic);
      if (i >= 0) rt.nodeInfo.subscriptions.splice(i, 1);
    },
    spawn: (config: NodeInstanceConfig): Promise<NodeInfo> => {
      const fn = deps.spawnNode;
      if (!fn) return Promise.reject(new Error("ctx.spawn unavailable: runner has no spawnNode dep"));
      return fn(config, nodeId);
    },
    kill: (targetId: string, reason?: string): boolean => {
      const fn = deps.killNode;
      if (!fn) throw new Error("ctx.kill unavailable: runner has no killNode dep");
      return fn(targetId, nodeId, reason);
    },
    callLLM: (_o: LLMRequest): Promise<LLMResponse> => Promise.reject(new Error("not implemented")),
    llm: buildLLMFacade(deps, rt.nodeInfo, signal),
    tools: buildToolsFacade(deps),
    skills: buildSkillsFacade(deps),
    callTool: (_s: string, _t: string, _p: unknown): Promise<unknown> => Promise.reject(new Error("not implemented")),
    readFile: (_id: string): Promise<FileContent> => Promise.reject(new Error("not implemented")),
    writeFile: (_n: string, _c: string, _o?: FileOpts): Promise<FileRef> => Promise.reject(new Error("not implemented")),
    listFiles: (_f?: FileFilter): Promise<FileInfo[]> => Promise.reject(new Error("not implemented")),
    state: rt.state,
    // Lazy: create the dir on first read so we don't pay the fs hit
    // for every node / every iteration. Path is stable across
    // restarts because it's keyed by node id, not name.
    get dataDir(): string {
      const d = path.join(DATA_ROOT, nodeId);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      return d;
    },
    log: (level, message, data) => { log.add(level, message, data); },
    node: { ...rt.nodeInfo },
    iteration: rt.iteration,
    wasPreempted: preemption !== null,
    preemptionContext: preemption ?? undefined,
    signal,
  };
}

/** Either wire a real LLMFacade or return a stub that throws on use.
 *  The stub keeps `ctx.llm` typed-present even on runners that don't
 *  inject the deps, so handler code doesn't have to null-check. */
function buildLLMFacade(deps: BuildContextDeps, nodeInfo: NodeInfo, signal: AbortSignal): ILLMFacade {
  if (!deps.llmRegistry || !deps.llmConfig) {
    const err = (): never => { throw new Error("ctx.llm unavailable: runner has no llmRegistry/llmConfig dep"); };
    return {
      text: (): Promise<string> => { err(); return Promise.reject(new Error("unreachable")); },
      tool: (): Promise<never> => { err(); return Promise.reject(new Error("unreachable")); },
      tools: (): Promise<never> => { err(); return Promise.reject(new Error("unreachable")); },
      agent: (): Promise<never> => { err(); return Promise.reject(new Error("unreachable")); },
      resolveModel: (): never => err(),
      listModels: (): never => err(),
    };
  }
  return new LLMFacade({
    registry: deps.llmRegistry,
    config: deps.llmConfig,
    bus: deps.bus,
    nodeId: nodeInfo.id,
    nodeName: nodeInfo.name,
    nodeType: nodeInfo.type,
    nodeModel: nodeInfo.config_overrides?.model as string | undefined,
    nodeCli: nodeInfo.config_overrides?.cli as string | undefined,
    nodeDataDir: path.join(DATA_ROOT, nodeInfo.id),
    signal,
  });
}

/** Build the tool-discovery facade.
 *  Aggregates every public (non-`internal`) subscription across the live
 *  network into the MCP-tool shape. Reads fresh on each call so newly-
 *  spawned nodes show up immediately.
 *
 *  Falls back to a stub that returns `[]` when the runner has no
 *  registry dep (test scaffolding) — handlers can still `.list()`
 *  without null-checking. */
function buildToolsFacade(deps: BuildContextDeps): ToolsFacade {
  const empty: ToolsFacade = {
    list: () => [],
    listForNode: () => [],
  };
  const registry = deps.instanceRegistry;
  if (!registry) return empty;
  // Local nodes plus peer-hub nodes (other machines). De-dup by id so a
  // node never appears twice if it surfaces in both lists; local wins.
  const allNodes = (): NodeInfo[] => {
    const local = registry.list();
    const peers = deps.peerNodes?.() ?? [];
    if (peers.length === 0) return local;
    const seen = new Set(local.map((n) => n.id));
    return [...local, ...peers.filter((n) => !seen.has(n.id))];
  };
  const collect = (filterNodeId?: string): ToolDescriptor[] => {
    const out: ToolDescriptor[] = [];
    for (const node of allNodes()) {
      if (filterNodeId && node.id !== filterNodeId) continue;
      // Route through the shared helper so wildcard-bound ports (alerts.*)
      // surface as a concrete subject the caller can actually publish on.
      for (const d of toolDescriptorsForNode(node)) out.push(d);
    }
    return out;
  };
  return {
    list: () => collect(),
    listForNode: (nodeId) => collect(nodeId),
  };
}

/** Build the skills facade. Talks to the network-wide skills service over
 *  NATS request/reply (location-transparent: works for a remote brain-agent
 *  node too). Falls back to a clear error when the bus has no request/reply
 *  (the in-memory test fixture) so the missing capability is obvious. */
function buildSkillsFacade(deps: BuildContextDeps): SkillsFacade {
  const bus = deps.bus as {
    requestRemote?: <T>(subject: string, payload: unknown, timeoutMs?: number) => Promise<T>;
  };
  const rr = bus.requestRemote;
  if (typeof rr !== "function") {
    const err = (): Promise<never> =>
      Promise.reject(new Error("ctx.skills unavailable: the bus has no request/reply (needs NATS)"));
    return { search: err, load: err, save: err, delete: err, list: err };
  }
  const call = <T>(subject: string, payload: unknown): Promise<T> =>
    rr.call(bus, subject, payload, 4000) as Promise<T>;
  return {
    search: (query, limit) => call<SkillInfo[]>(SKILLS_SEARCH_SUBJECT, { query, limit }),
    list: () => call<SkillInfo[]>(SKILLS_LIST_SUBJECT, {}),
    load: (name) => call<SkillContent | null>(SKILLS_LOAD_SUBJECT, { name }),
    save: async (name, content) => {
      const r = await call<SkillContent & { error?: string }>(SKILLS_SAVE_SUBJECT, { name, content });
      if (r && typeof r === "object" && "error" in r && r.error) throw new Error(r.error);
      return r;
    },
    delete: (name) => call<boolean>(SKILLS_DELETE_SUBJECT, { name }),
  };
}
