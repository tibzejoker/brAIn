import {
  type NodeInfo,
  type NodeHandler,
  type NodeOnSpawn,
  type NodeTeardown,
  type NodeContext,
  type NodeInstanceConfig,
  type Message,
  type WakeCondition,
  type PreemptionContext,
  type RunMode,
  NodeState,
} from "@brain/sdk";
import { buildNodeContext } from "./context-builder";
import type { IBusService } from "../bus/bus.interface";
import type { InstanceRegistry } from "../registry/instance-registry";
import type { SleepService } from "./sleep.service";
import { NodeLog, type LogEntry } from "./node-log";
import { PreemptionMonitor } from "./preemption";
import { logger } from "../logger";

export const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const WATCHER_INTERVAL_MS = 1_000;

export interface RunnerDeps {
  bus: IBusService;
  registry: InstanceRegistry;
  sleepService: SleepService;
  /**
   * Optional bridges back to the lifecycle. When provided, `ctx.spawn`
   * / `ctx.kill` route through them with the running node's id as
   * caller (so AuthorityService gates the operation). The brain
   * service wires these to its own `spawnNode` / `killNode`. Tests
   * with a stubbed runner can omit them — handlers that try to use
   * `ctx.spawn` without them get a clear error.
   */
  spawnNode?: (config: NodeInstanceConfig, caller?: string) => Promise<NodeInfo>;
  killNode?: (id: string, caller?: string, reason?: string) => boolean;
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

  private teardownFired = false;
  private onSpawnFired = false;

  // Shared
  protected iteration = 0;
  protected readonly state: Record<string, unknown> = {};
  protected readonly handlerTimeoutMs: number;
  readonly log = new NodeLog();

  // Dead-letter queue: messages that were in flight when the handler
  // crashed or timed out. Bounded ring; the dashboard's NodePanel
  // surfaces it under a "DLQ" badge so users can spot poison messages.
  private readonly deadLetters: Array<{ ts: number; error: string; message: Message }> = [];
  private static readonly DLQ_MAX = 50;

  // Preemption: when a handler is in flight and a higher-criticality
  // message lands, we abort it so the next iteration can prioritise
  // the urgent one.
  private readonly preemption: PreemptionMonitor;

  constructor(
    protected readonly nodeInfo: NodeInfo,
    protected readonly handler: NodeHandler,
    protected readonly deps: RunnerDeps,
    runMode?: RunMode,
    protected readonly teardown?: NodeTeardown,
    protected readonly onSpawn?: NodeOnSpawn,
  ) {
    this.handlerTimeoutMs = typeof nodeInfo.config_overrides?.handler_timeout_ms === "number"
      ? nodeInfo.config_overrides.handler_timeout_ms
      : DEFAULT_HANDLER_TIMEOUT_MS;
    // Default threshold: incoming must exceed active iteration's max
    // criticality by > 3 (e.g. crit 3 active → preempted by crit ≥ 7).
    const threshold = typeof nodeInfo.config_overrides?.preemption_threshold === "number"
      ? nodeInfo.config_overrides.preemption_threshold
      : 3;
    this.preemption = new PreemptionMonitor(deps.bus, nodeInfo.id, this.log, threshold);
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
    void this.bootstrap();
  }

  /**
   * Run `onSpawn` to completion BEFORE the first handler tick, so
   * handlers that initialise per-instance state in onSpawn don't
   * race the runner's first invocation. Without this, zero-subscription
   * nodes can land in the handler before their onSpawn microtask
   * fires (handler runs synchronously up to its first await, while
   * onSpawn is queued on the microtask queue).
   */
  private async bootstrap(): Promise<void> {
    await this.runOnSpawn();
    // Nodes with at least one subscription bootstrap reactively when a
    // matching message lands. Nodes with zero subscriptions (clock,
    // cron, anything purely timer-based) would otherwise never fire,
    // because tryRun's hasUnreadMessages guard gates them out — bypass
    // the guard with one explicit run on start so they get a chance to
    // schedule their first sleep timer.
    if (this.nodeInfo.subscriptions.length === 0) {
      this.startRun();
    } else {
      this.tryRun();
    }
  }

  private async runOnSpawn(): Promise<void> {
    if (this.onSpawnFired) return;
    this.onSpawnFired = true;
    const fn = this.onSpawn;
    if (!fn) return;
    try { await fn(this.nodeInfo); }
    catch (err) {
      this.log.error(`onSpawn failed: ${err instanceof Error ? err.message : String(err)}`);
      logger.error({ err, node: this.nodeInfo.name }, "onSpawn failed");
    }
  }

  stop(): void {
    this.running = false;
    if (this.watcherTimer) { clearInterval(this.watcherTimer); this.watcherTimer = undefined; }
    if (this.messageListener) {
      this.deps.bus.removeListener(`message:${this.nodeInfo.id}`, this.messageListener);
      this.messageListener = undefined;
    }
    this.deps.sleepService.unregisterSleep(this.nodeInfo.id);
    this.runTeardown();
  }

  private runTeardown(): void {
    if (this.teardownFired) return;
    this.teardownFired = true;
    const t = this.teardown;
    if (!t) return;
    const info = this.nodeInfo;
    void Promise.resolve()
      .then(() => t(info))
      .catch((err: unknown) => {
        this.log.error(`teardown failed: ${err instanceof Error ? err.message : String(err)}`);
        logger.error({ err, node: this.nodeInfo.name }, "teardown failed");
      });
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

  private startRun(): void {
    if (!this.running || this.busy) return;
    this.busy = true;
    void this.run().finally(() => { this.busy = false; });
  }

  protected tryRun(): void {
    if (this.runMode === "manual") return;
    if (!this.deps.bus.hasUnreadMessages(this.nodeInfo.id)) return;
    if (this.sleeping && !this.shouldWake()) return;
    if (this.busy) {
      this.preemption.inspect();
      return;
    }
    this.startRun();
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
      const hadMessages = this.deps.bus.hasUnreadMessages(this.nodeInfo.id);
      this.sleeping = false;
      this.sleepConditions = [];
      this.deps.sleepService.unregisterSleep(this.nodeInfo.id);
      this.deps.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);
      this.log.info(hadMessages ? "Woken by message" : "Woken by timer");

      this.state._wake_reason = hadMessages ? "message" : "timer";
    } else {
      this.state._wake_reason = "running";
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

    // Arm preemption: bus listener pings inspect() on every incoming
    // message and aborts the signal if the criticality bar is breached.
    const { signal, preemption } = this.preemption.arm(messages);
    const ctx = this.buildContext(messages, signal, preemption);

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
      // Handlers sometimes catch their own abort errors and return
      // cleanly (e.g. wrapping generateText in try/catch). Detect the
      // preemption from the signal state, not from a thrown error,
      // so the next iteration still gets the PreemptionContext.
      if (this.preemption.wasPreempted()) {
        this.log.info(`Iteration ${this.iteration} preempted`);
      }
    } catch (err) {
      if (this.preemption.wasPreempted()) {
        this.log.info(`Iteration ${this.iteration} preempted`);
      } else {
        this.recordHandlerError(err, messages);
      }
    } finally {
      this.preemption.disarm();
    }
  }

  private recordHandlerError(err: unknown, messages: Message[]): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    this.log.error(`Handler error: ${errMsg}`);
    logger.error({ err, node: this.nodeInfo.name, iteration: this.iteration }, "Handler error");
    const ts = Date.now();
    for (const m of messages) {
      this.deadLetters.push({ ts, error: errMsg, message: m });
      if (this.deadLetters.length > BaseRunner.DLQ_MAX) this.deadLetters.shift();
    }
  }

  /**
   * Snapshot of the dead-letter queue (oldest → newest). Each entry
   * pairs a message that was being processed when the handler failed
   * with the error string + timestamp. Bounded ring of 50 entries.
   */
  getDeadLetters(): Array<{ ts: number; error: string; message: Message }> {
    return [...this.deadLetters];
  }

  protected enterSleep(): void {
    this.sleepRequested = false;
    this.sleeping = true;
    this.sleepConditions = this.pendingSleepConditions;
    this.deps.registry.updateState(this.nodeInfo.id, NodeState.SLEEPING);

    this.deps.sleepService.registerSleep(this.nodeInfo.id, this.sleepConditions, () => {
      this.sleeping = false; this.sleepConditions = []; this.startRun();
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

  // === Context builder (delegated to ./context-builder) ===

  protected buildContext(
    messages: Message[],
    signal: AbortSignal,
    preemption: PreemptionContext | null,
  ): NodeContext {
    return buildNodeContext(
      {
        nodeInfo: this.nodeInfo,
        state: this.state,
        log: this.log,
        iteration: this.iteration,
        requestSleep: (conditions: WakeCondition[]) => {
          this.sleepRequested = true;
          this.pendingSleepConditions = conditions;
        },
      },
      { bus: this.deps.bus, spawnNode: this.deps.spawnNode, killNode: this.deps.killNode },
      messages, signal, preemption,
    );
  }
}
