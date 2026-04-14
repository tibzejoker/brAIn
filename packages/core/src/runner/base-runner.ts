import {
  type NodeInfo,
  type NodeHandler,
  type NodeContext,
  type Message,
  type WakeCondition,
  type ReadMessagesOptions,
  type MailboxConfig,
  type LLMRequest,
  type LLMResponse,
  type FileOpts,
  type FileRef,
  type FileContent,
  type FileFilter,
  type FileInfo,
  type RunMode,
  NodeState,
} from "@brain/sdk";
import type { BusService } from "../bus/bus.service";
import type { InstanceRegistry } from "../registry/instance-registry";
import type { SleepService } from "./sleep.service";
import { NodeLog, type LogEntry } from "./node-log";
import { logger } from "../logger";

export const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const WATCHER_INTERVAL_MS = 1_000;

export interface RunnerDeps {
  bus: BusService;
  registry: InstanceRegistry;
  sleepService: SleepService;
}

/**
 * Base runner — handles lifecycle, timers, busy lock, sleep/wake.
 * Subclasses override `executionLoop()` to define their execution strategy.
 */
export abstract class BaseRunner {
  private running = false;
  private busy = false;
  private runMode: RunMode;
  private watcherTimer?: NodeJS.Timeout;
  private messageListener?: () => void;

  // Sleep
  protected sleeping = false;
  protected sleepConditions: WakeCondition[] = [];
  protected sleepRequested = false;
  protected pendingSleepConditions: WakeCondition[] = [];

  // Shared
  protected iteration = 0;
  protected readonly state: Record<string, unknown> = {};
  protected readonly handlerTimeoutMs: number;
  readonly log = new NodeLog();

  constructor(
    protected readonly nodeInfo: NodeInfo,
    protected readonly handler: NodeHandler,
    protected readonly deps: RunnerDeps,
    runMode?: RunMode,
  ) {
    this.handlerTimeoutMs = typeof nodeInfo.config_overrides?.handler_timeout_ms === "number"
      ? nodeInfo.config_overrides.handler_timeout_ms
      : DEFAULT_HANDLER_TIMEOUT_MS;
    this.runMode = runMode ?? "auto";
  }

  // === Public API ===

  start(): void {
    this.running = true;
    this.deps.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
    this.log.info(`Started (${this.constructor.name}, mode: ${this.runMode})`);

    this.messageListener = (): void => { this.tryRun(); };
    this.deps.bus.on(`message:${this.nodeInfo.id}`, this.messageListener);

    this.watcherTimer = setInterval(() => { this.tryRun(); }, WATCHER_INTERVAL_MS);
    this.tryRun();
  }

  stop(): void {
    this.running = false;
    if (this.watcherTimer) { clearInterval(this.watcherTimer); this.watcherTimer = undefined; }
    if (this.messageListener) {
      this.deps.bus.removeListener(`message:${this.nodeInfo.id}`, this.messageListener);
      this.messageListener = undefined;
    }
    this.deps.sleepService.unregisterSleep(this.nodeInfo.id);
  }

  tick(): void { this.tryRun(); }

  getLogs(last?: number): LogEntry[] {
    return last ? this.log.getLast(last) : this.log.getAll();
  }

  getRunMode(): RunMode { return this.runMode; }

  setRunMode(mode: RunMode): void {
    const prev = this.runMode;
    this.runMode = mode;
    logger.info({ nodeId: this.nodeInfo.id, from: prev, to: mode }, "Run mode changed");
  }

  // === Trigger ===

  private tryRun(): void {
    if (!this.running || this.busy || this.runMode === "manual") return;
    if (!this.deps.bus.hasUnreadMessages(this.nodeInfo.id)) return;
    if (this.sleeping && !this.shouldWake()) return;

    this.busy = true;
    void this.run().finally(() => { this.busy = false; });
  }

  private shouldWake(): boolean {
    return this.sleepConditions.some((c) => {
      if (c.type === "any") return true;
      if (c.type === "topic") return this.deps.bus.hasUnreadForPattern(this.nodeInfo.id, c.value);
      return false;
    });
  }

  private async run(): Promise<void> {
    const wasSleeping = this.sleeping;
    if (this.sleeping) {
      this.sleeping = false;
      this.sleepConditions = [];
      this.deps.sleepService.unregisterSleep(this.nodeInfo.id);
      this.deps.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
      this.log.info("Woken by message");
    }
    this.state._woke_from_sleep = wasSleeping;

    await this.executionLoop();
  }

  // === Abstract: subclasses define their execution strategy ===

  protected abstract executionLoop(): Promise<void>;

  // === Shared tools ===

  protected async runHandler(): Promise<void> {
    this.iteration++;
    const messages = this.deps.bus.getUnreadMessages(this.nodeInfo.id);

    if (messages.length > 0) {
      this.log.info(`Iteration ${this.iteration}: ${messages.length} message(s)`, {
        topics: [...new Set(messages.map((m) => m.topic))],
      });
    }

    const ctx = this.buildContext(messages);

    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.handler(ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Handler timeout after ${this.handlerTimeoutMs}ms`)),
            this.handlerTimeoutMs,
          );
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Handler error: ${errMsg}`);
      logger.error({ err, node: this.nodeInfo.name, iteration: this.iteration }, "Handler error");
    }
  }

  protected enterSleep(): void {
    this.sleepRequested = false;
    this.sleeping = true;
    this.sleepConditions = this.pendingSleepConditions;
    this.deps.registry.updateState(this.nodeInfo.id, NodeState.SLEEPING);

    this.deps.sleepService.registerSleep(this.nodeInfo.id, this.sleepConditions, () => {
      this.sleeping = false;
      this.sleepConditions = [];
      this.tryRun();
    });

    const desc = this.sleepConditions
      .map((c) => c.type === "timer" ? `timer:${c.value}` : c.type === "topic" ? `topic:${c.value}` : "any")
      .join(", ");
    this.log.info(`sleep [${desc}]`);
  }

  protected forceSleep(duration: string): void {
    this.sleepRequested = false;
    this.pendingSleepConditions = [{ type: "timer", value: duration }, { type: "any" }];
    this.enterSleep();
    this.log.info(`forced sleep [${duration}]`);
  }

  protected autoSleep(): void {
    this.sleepRequested = false;
    this.pendingSleepConditions = [{ type: "any" }];
    this.enterSleep();
  }

  // === Context builder ===

  protected buildContext(messages: Message[]): NodeContext {
    const nodeId = this.nodeInfo.id;
    const bus = this.deps.bus;
    const self = this;

    // Resolve response topic: config override > default_publishes[0]
    const responseTopic = (self.nodeInfo.config_overrides?.response_topic as string | undefined)
      ?? self.nodeInfo.default_publishes?.[0]
      ?? "";

    return {
      messages,
      readMessages: (opts?: ReadMessagesOptions): Message[] => bus.readMessages(nodeId, opts),
      respond(content: string, metadata?: Record<string, unknown>): void {
        if (!responseTopic) {
          self.log.error("respond() called but no response_topic configured");
          return;
        }
        self.log.info(`respond → ${responseTopic}`);
        bus.publish({
          from: nodeId, topic: responseTopic,
          type: "text", criticality: 1,
          payload: { content },
          metadata,
        });
      },
      publish(topic: string, msg: Omit<Message, "id" | "from" | "timestamp" | "topic">): void {
        self.log.info(`publish ${topic} (crit:${msg.criticality})`);
        bus.publish({ ...msg, from: nodeId, topic });
      },
      subscribe(topic: string, mailbox?: Partial<MailboxConfig>): void {
        self.log.info(`+ subscribe ${topic}`);
        bus.subscribe(nodeId, topic, { mailbox });
      },
      unsubscribe: (topic: string): void => { bus.unsubscribe(nodeId, topic); },
      sleep: (conditions: WakeCondition[]): void => {
        self.sleepRequested = true;
        self.pendingSleepConditions = conditions;
      },
      callLLM: (_o: LLMRequest): Promise<LLMResponse> => Promise.reject(new Error("not implemented")),
      callTool: (_s: string, _t: string, _p: unknown): Promise<unknown> => Promise.reject(new Error("not implemented")),
      readFile: (_id: string): Promise<FileContent> => Promise.reject(new Error("not implemented")),
      writeFile: (_n: string, _c: string, _o?: FileOpts): Promise<FileRef> => Promise.reject(new Error("not implemented")),
      listFiles: (_f?: FileFilter): Promise<FileInfo[]> => Promise.reject(new Error("not implemented")),
      state: self.state,
      log: (level: "info" | "warn" | "error" | "debug", message: string, data?: Record<string, unknown>): void => {
        self.log.add(level, message, data);
      },
      node: { ...self.nodeInfo },
      iteration: self.iteration,
      wasPreempted: false,
      preemptionContext: undefined,
    };
  }
}
