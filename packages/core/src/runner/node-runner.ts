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

const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const WATCHER_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_FORCED_SLEEP = "30s";

/**
 * NodeRunner — execution model:
 *
 * Two triggers can start an iteration:
 *   1. A message arrives on the bus (callback)
 *   2. A 1-second watcher interval (catches anything missed)
 *
 * When triggered, if the runner is already executing ("busy"), the trigger
 * is a no-op — the current execution loop will check for pending messages.
 *
 * For LLM nodes (tag "llm"), the runner supports a multi-iteration budget:
 *   - After each handler call, if there are pending messages OR the handler
 *     didn't request sleep, the runner re-invokes the handler.
 *   - The handler receives a budget warning in ctx.state._iterations_remaining.
 *   - When budget is exhausted, the runner forces a sleep.
 *   - The handler can sleep early to preserve budget.
 */
export class NodeRunner {
  private running = false;
  private busy = false;
  private iteration = 0;
  private readonly state: Record<string, unknown> = {};
  private readonly handlerTimeoutMs: number;
  private readonly isLLM: boolean;
  private readonly maxIterations: number;
  private readonly forcedSleepDuration: string;
  private runMode: RunMode;
  readonly log = new NodeLog();

  // Sleep state
  private sleeping = false;
  private sleepConditions: WakeCondition[] = [];

  // Timers
  private watcherTimer?: NodeJS.Timeout;
  private messageListener?: () => void;

  // Sleep request from handler
  private sleepRequested = false;
  private pendingSleepConditions: WakeCondition[] = [];

  constructor(
    private readonly nodeInfo: NodeInfo,
    private readonly handler: NodeHandler,
    private readonly bus: BusService,
    private readonly registry: InstanceRegistry,
    private readonly sleepService: SleepService,
    _intervalStr?: string,
    runMode?: RunMode,
  ) {
    this.handlerTimeoutMs = typeof nodeInfo.config_overrides?.handler_timeout_ms === "number"
      ? nodeInfo.config_overrides.handler_timeout_ms
      : DEFAULT_HANDLER_TIMEOUT_MS;
    this.isLLM = nodeInfo.tags.includes("llm");
    this.maxIterations = typeof nodeInfo.config_overrides?.max_iterations === "number"
      ? nodeInfo.config_overrides.max_iterations
      : DEFAULT_MAX_ITERATIONS;
    this.forcedSleepDuration = typeof nodeInfo.config_overrides?.forced_sleep === "string"
      ? nodeInfo.config_overrides.forced_sleep
      : DEFAULT_FORCED_SLEEP;
    this.runMode = runMode ?? "auto";
  }

  getLogs(last?: number): LogEntry[] {
    return last ? this.log.getLast(last) : this.log.getAll();
  }

  start(): void {
    this.running = true;
    this.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
    this.log.info(`Started (mode: ${this.runMode}, llm: ${this.isLLM})`);

    // Trigger 1: message callback
    this.messageListener = (): void => { this.tryRun(); };
    this.bus.on(`message:${this.nodeInfo.id}`, this.messageListener);

    // Trigger 2: watcher interval
    this.watcherTimer = setInterval(() => { this.tryRun(); }, WATCHER_INTERVAL_MS);

    // Kick off first iteration immediately
    this.tryRun();
  }

  stop(): void {
    this.running = false;

    if (this.watcherTimer) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = undefined;
    }

    if (this.messageListener) {
      this.bus.removeListener(`message:${this.nodeInfo.id}`, this.messageListener);
      this.messageListener = undefined;
    }

    this.sleepService.unregisterSleep(this.nodeInfo.id);
  }

  tick(): void {
    this.tryRun();
  }

  getRunMode(): RunMode {
    return this.runMode;
  }

  setRunMode(mode: RunMode): void {
    const prev = this.runMode;
    this.runMode = mode;
    logger.info({ nodeId: this.nodeInfo.id, from: prev, to: mode }, "Run mode changed");
  }

  // === Core execution logic ===

  private tryRun(): void {
    if (!this.running) return;
    if (this.busy) return;
    if (this.runMode === "manual") return;

    if (!this.bus.hasUnreadMessages(this.nodeInfo.id)) return;

    if (this.sleeping && !this.shouldWake()) return;

    this.busy = true;
    void this.executionLoop().finally(() => {
      this.busy = false;
    });
  }

  private shouldWake(): boolean {
    for (const cond of this.sleepConditions) {
      if (cond.type === "any") return true;
      if (cond.type === "topic") {
        if (this.bus.hasUnreadForPattern(this.nodeInfo.id, cond.value)) return true;
      }
    }
    return false;
  }

  /**
   * Main execution loop.
   *
   * For service nodes: run once, done.
   * For LLM nodes: run up to maxIterations, re-invoking if there are
   * pending messages or the handler didn't sleep.
   */
  private async executionLoop(): Promise<void> {
    // Wake up if sleeping
    const wasSleeping = this.sleeping;
    if (this.sleeping) {
      this.sleeping = false;
      this.sleepConditions = [];
      this.sleepService.unregisterSleep(this.nodeInfo.id);
      this.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
      this.log.info("Woken by message");
    }

    // Inject wake context for LLM handlers
    this.state._woke_from_sleep = wasSleeping;

    if (!this.isLLM) {
      // Simple service node: run once, then auto-sleep
      await this.runOnce();
      if (!this.sleepRequested) {
        this.sleepRequested = true;
        this.pendingSleepConditions = [{ type: "any" }];
      }
      this.enterSleep();
      return;
    }

    // LLM node: iteration budget loop
    for (let i = 0; i < this.maxIterations; i++) {
      const remaining = this.maxIterations - i;

      // Inject budget info into state so the handler/prompt can see it
      this.state._iterations_remaining = remaining;
      this.state._iterations_total = this.maxIterations;
      if (remaining <= 3) {
        this.state._budget_warning = `WARNING: You will be force-slept in ${remaining} iteration(s). Wrap up or sleep now.`;
      } else {
        delete this.state._budget_warning;
      }

      await this.runOnce();

      // Handler requested sleep — respect it
      if (this.sleepRequested) {
        this.enterSleep();
        return;
      }

      // Check for pending messages
      const hasPending = this.bus.hasUnreadMessages(this.nodeInfo.id);

      if (!hasPending && i > 0) {
        // No pending messages and not the first iteration — LLM had its chance
        // Auto-sleep since there's nothing to do
        this.log.info("No pending messages, auto-sleeping");
        this.forceSleep();
        return;
      }

      if (!hasPending) {
        // First iteration, no pending — done, just idle (watcher will catch next message)
        return;
      }

      // There are pending messages — continue the loop
      this.log.info(`Pending messages detected, continuing (${remaining - 1} iterations left)`);
    }

    // Budget exhausted
    this.log.info(`Iteration budget exhausted (${this.maxIterations}), forcing sleep`);
    this.forceSleep();
  }

  private async runOnce(): Promise<void> {
    this.iteration++;
    const messages = this.bus.getUnreadMessages(this.nodeInfo.id);

    if (messages.length > 0) {
      this.log.info(`Iteration ${this.iteration}: ${messages.length} message(s)`, {
        topics: [...new Set(messages.map((m) => m.topic))],
      });
    } else {
      this.log.debug(`Iteration ${this.iteration}: idle`);
      return;
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
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Handler error: ${errMsg}`);
      logger.error(
        { err, node: this.nodeInfo.name, iteration: this.iteration },
        "Handler error",
      );
    }
  }

  private enterSleep(): void {
    this.sleepRequested = false;
    this.sleeping = true;
    this.sleepConditions = this.pendingSleepConditions;
    this.registry.updateState(this.nodeInfo.id, NodeState.SLEEPING);

    this.sleepService.registerSleep(
      this.nodeInfo.id,
      this.sleepConditions,
      () => {
        this.sleeping = false;
        this.sleepConditions = [];
        this.tryRun();
      },
    );

    const desc = this.sleepConditions
      .map((c) => c.type === "timer" ? `timer:${c.value}` : c.type === "topic" ? `topic:${c.value}` : "any")
      .join(", ");
    this.log.info(`💤 sleep [${desc}]`);
  }

  private forceSleep(): void {
    this.sleeping = true;
    this.sleepConditions = [
      { type: "timer", value: this.forcedSleepDuration },
      { type: "any" },
    ];
    this.registry.updateState(this.nodeInfo.id, NodeState.SLEEPING);

    this.sleepService.registerSleep(
      this.nodeInfo.id,
      this.sleepConditions,
      () => {
        this.sleeping = false;
        this.sleepConditions = [];
        this.tryRun();
      },
    );

    this.log.info(`💤 forced sleep [timer:${this.forcedSleepDuration}, any]`);
  }

  // === Context builder ===

  private buildContext(messages: Message[]): NodeContext {
    const nodeId = this.nodeInfo.id;
    const bus = this.bus;
    const self = this;

    return {
      messages,

      readMessages(opts?: ReadMessagesOptions): Message[] {
        return bus.readMessages(nodeId, opts);
      },

      publish(
        topic: string,
        msg: Omit<Message, "id" | "from" | "timestamp" | "topic">,
      ): void {
        self.log.info(`→ publish ${topic} (crit:${msg.criticality})`);
        bus.publish({
          ...msg,
          from: nodeId,
          topic,
        });
      },

      subscribe(topic: string, mailbox?: Partial<MailboxConfig>): void {
        self.log.info(`+ subscribe ${topic}`);
        bus.subscribe(nodeId, topic, { mailbox });
      },

      unsubscribe(topic: string): void {
        bus.unsubscribe(nodeId, topic);
      },

      sleep(conditions: WakeCondition[]): void {
        self.sleepRequested = true;
        self.pendingSleepConditions = conditions;
      },

      callLLM: (_opts: LLMRequest): Promise<LLMResponse> => Promise.reject(new Error("callLLM not implemented")),
      callTool: (_s: string, _t: string, _p: unknown): Promise<unknown> => Promise.reject(new Error("callTool not implemented")),
      readFile: (_id: string): Promise<FileContent> => Promise.reject(new Error("readFile not implemented")),
      writeFile: (_n: string, _c: string, _o?: FileOpts): Promise<FileRef> => Promise.reject(new Error("writeFile not implemented")),
      listFiles: (_f?: FileFilter): Promise<FileInfo[]> => Promise.reject(new Error("listFiles not implemented")),

      state: self.state,

      log(level: "info" | "warn" | "error" | "debug", message: string, data?: Record<string, unknown>): void {
        self.log.add(level, message, data);
      },

      node: { ...self.nodeInfo },
      iteration: self.iteration,
      wasPreempted: false,
      preemptionContext: undefined,
    };
  }
}
