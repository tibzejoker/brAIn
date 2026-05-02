/**
 * Builds the per-iteration NodeContext handed to a node's handler.
 *
 * Extracted from base-runner so the runner stays under the 300-line
 * lint cap and the context surface is reviewable in isolation.
 *
 * The handler-facing surface is intentionally narrow: bus IO, sleep,
 * lifecycle (spawn/kill — auth-gated), state, and a few stubs that
 * concrete runners override (LLM, tools, files).
 */
import type {
  NodeContext, NodeInfo, NodeInstanceConfig, Message, WakeCondition,
  ReadMessagesOptions, MailboxConfig, LLMRequest, LLMResponse,
  FileOpts, FileRef, FileContent, FileFilter, FileInfo, PreemptionContext,
} from "@brain/sdk";
import type { IBusService } from "../bus/bus.interface";
import type { NodeLog } from "./node-log";

export interface BuildContextDeps {
  bus: IBusService;
  spawnNode?: (c: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killNode?: (id: string, caller?: string, reason?: string) => boolean;
}

export interface BuildContextRuntime {
  nodeInfo: NodeInfo;
  state: Record<string, unknown>;
  log: NodeLog;
  iteration: number;
  /** Mutable hooks the runner uses to honour ctx.sleep(). */
  requestSleep: (conditions: WakeCondition[]) => void;
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
    messages,
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
    subscribe(
      topic: string,
      opts?: {
        description?: string;
        inputSchema?: Record<string, unknown>;
        mailbox?: Partial<MailboxConfig>;
      },
    ): void {
      log.info(`+ subscribe ${topic}`);
      bus.subscribe(nodeId, topic, { mailbox: opts?.mailbox });
      // When the caller declares the subscription's purpose, mirror it
      // into NodeInfo.subscriptions so the framework MCP service (and
      // anything else reading the static catalog) sees it as a
      // first-class capability instead of a hidden bus listener.
      if (opts?.description) {
        const existing = rt.nodeInfo.subscriptions.findIndex((s) => s.topic === topic);
        const entry = {
          topic, description: opts.description,
          inputSchema: opts.inputSchema, mailbox: opts.mailbox,
        };
        if (existing >= 0) rt.nodeInfo.subscriptions[existing] = entry;
        else rt.nodeInfo.subscriptions.push(entry);
      }
    },
    unsubscribe: (topic: string): void => {
      bus.unsubscribe(nodeId, topic);
      const i = rt.nodeInfo.subscriptions.findIndex((s) => s.topic === topic);
      if (i >= 0) rt.nodeInfo.subscriptions.splice(i, 1);
    },
    sleep: (conditions: WakeCondition[]): void => { rt.requestSleep(conditions); },
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
    callTool: (_s: string, _t: string, _p: unknown): Promise<unknown> => Promise.reject(new Error("not implemented")),
    readFile: (_id: string): Promise<FileContent> => Promise.reject(new Error("not implemented")),
    writeFile: (_n: string, _c: string, _o?: FileOpts): Promise<FileRef> => Promise.reject(new Error("not implemented")),
    listFiles: (_f?: FileFilter): Promise<FileInfo[]> => Promise.reject(new Error("not implemented")),
    state: rt.state,
    log: (level, message, data) => { log.add(level, message, data); },
    node: { ...rt.nodeInfo },
    iteration: rt.iteration,
    wasPreempted: preemption !== null,
    preemptionContext: preemption ?? undefined,
    signal,
  };
}
