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

/**
 * NodeRunner — simple execution model:
 *
 * Two triggers can start an iteration:
 *   1. A message arrives on the bus (callback)
 *   2. A 1-second watcher interval (catches anything missed)
 *
 * When triggered, if the runner is already executing ("busy"), the trigger
 * is a no-op — the watcher will pick up pending messages after the current
 * iteration finishes.
 *
 * Sleep: when a handler calls ctx.sleep(), the watcher and message callback
 * still run, but they only start an iteration if a wake condition is met.
 */
export class NodeRunner {
  private running = false;
  private busy = false;
  private iteration = 0;
  private readonly state: Record<string, unknown> = {};
  private readonly handlerTimeoutMs: number;
  private runMode: RunMode;
  readonly log = new NodeLog();

  // Sleep state
  private sleeping = false;
  private sleepConditions: WakeCondition[] = [];

  // Timers
  private watcherTimer?: NodeJS.Timeout;
  private messageListener?: () => void;

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
    this.runMode = runMode ?? "auto";
  }

  getLogs(last?: number): LogEntry[] {
    return last ? this.log.getLast(last) : this.log.getAll();
  }

  start(): void {
    this.running = true;
    this.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
    this.log.info(`Started (mode: ${this.runMode})`);

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

  /** Manual tick — triggers an iteration if not busy. */
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
    if (this.runMode === "manual") return; // manual mode only runs via tick()

    // Check if there are unread messages
    if (!this.bus.hasUnreadMessages(this.nodeInfo.id)) return;

    // If sleeping, check wake conditions before running
    if (this.sleeping && !this.shouldWake()) return;

    // Take the lock and run
    this.busy = true;
    void this.executeIteration().finally(() => {
      this.busy = false;
    });
  }

  private shouldWake(): boolean {
    // Check if any wake condition is satisfied by the current unread messages
    for (const cond of this.sleepConditions) {
      if (cond.type === "any") return true;

      if (cond.type === "topic") {
        if (this.bus.hasUnreadForPattern(this.nodeInfo.id, cond.value)) return true;
      }
      // Timer wakes are handled by the SleepService
    }
    return false;
  }

  private async executeIteration(): Promise<void> {
    // If we were sleeping, wake up
    if (this.sleeping) {
      this.sleeping = false;
      this.sleepConditions = [];
      this.sleepService.unregisterSleep(this.nodeInfo.id);
      this.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
      this.log.info("Woken by message");
    }

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

    // Handle sleep request from handler
    if (this.sleepRequested) {
      this.sleepRequested = false;
      this.sleeping = true;
      this.sleepConditions = this.pendingSleepConditions;
      this.registry.updateState(this.nodeInfo.id, NodeState.SLEEPING);

      // Register with SleepService for timer-based wakes and persistence
      this.sleepService.registerSleep(
        this.nodeInfo.id,
        this.sleepConditions,
        () => {
          // Timer wake or external wake — trigger a run
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
  }

  // === Sleep request from handler ===
  private sleepRequested = false;
  private pendingSleepConditions: WakeCondition[] = [];

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

      callLLM(_opts: LLMRequest): Promise<LLMResponse> {
        return Promise.reject(new Error("callLLM not yet implemented"));
      },

      callTool(
        _server: string,
        _tool: string,
        _params: unknown,
      ): Promise<unknown> {
        return Promise.reject(new Error("callTool not yet implemented"));
      },

      readFile(_id: string): Promise<FileContent> {
        return Promise.reject(new Error("readFile not yet implemented"));
      },

      writeFile(
        _name: string,
        _content: string,
        _opts?: FileOpts,
      ): Promise<FileRef> {
        return Promise.reject(new Error("writeFile not yet implemented"));
      },

      listFiles(_filter?: FileFilter): Promise<FileInfo[]> {
        return Promise.reject(new Error("listFiles not yet implemented"));
      },

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
