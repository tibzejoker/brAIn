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
import { IdleThrottle } from "./idle-throttle";
import { logger } from "../logger";

export class NodeRunner {
  private running = false;
  private iteration = 0;
  private readonly state: Record<string, unknown> = {};
  private readonly throttle = new IdleThrottle();
  private readonly intervalMs?: number;
  private sleepRequested = false;
  private sleepConditions: WakeCondition[] = [];
  private wakeResolve?: () => void;
  private manualTickResolve?: () => void;
  private runMode: RunMode;

  constructor(
    private readonly nodeInfo: NodeInfo,
    private readonly handler: NodeHandler,
    private readonly bus: BusService,
    private readonly registry: InstanceRegistry,
    private readonly sleepService: SleepService,
    intervalStr?: string,
    runMode?: RunMode,
  ) {
    if (intervalStr) {
      this.intervalMs = this.sleepService.parseInterval(intervalStr);
    }
    this.runMode = runMode ?? "auto";
  }

  async start(): Promise<void> {
    this.running = true;
    this.registry.updateState(this.nodeInfo.id, NodeState.ACTIVE);

    // Listen for new messages to interrupt idle throttle
    this.bus.on(`message:${this.nodeInfo.id}`, () => {
      this.throttle.reset();
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = undefined;
      }
    });

    if (this.runMode === "manual") {
      // Manual mode: wait for explicit tick signals
      while (this.isRunning()) {
        await this.waitForTick();
        if (!this.isRunning()) break;
        await this.runIteration();

        if (this.sleepRequested) {
          this.sleepRequested = false;
          await this.enterSleep(this.sleepConditions);
        }
      }
    } else {
      // Auto mode: normal loop
      while (this.isRunning()) {
        await this.runIteration();

        if (this.sleepRequested) {
          this.sleepRequested = false;
          await this.enterSleep(this.sleepConditions);
          continue;
        }

        const delay = this.intervalMs ?? this.throttle.onIteration(
          this.bus.hasUnreadMessages(this.nodeInfo.id),
        );

        if (delay > 0) {
          await this.delay(delay);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    this.sleepService.unregisterSleep(this.nodeInfo.id);
    // Unblock manual tick wait if pending
    if (this.manualTickResolve) {
      this.manualTickResolve();
      this.manualTickResolve = undefined;
    }
  }

  /**
   * Trigger a single iteration in manual mode.
   * No-op in auto mode (the loop handles itself).
   */
  tick(): void {
    if (this.manualTickResolve) {
      this.manualTickResolve();
      this.manualTickResolve = undefined;
    }
  }

  getRunMode(): RunMode {
    return this.runMode;
  }

  setRunMode(mode: RunMode): void {
    const prev = this.runMode;
    this.runMode = mode;
    if (prev === "manual" && mode === "auto") {
      // Unblock the tick wait so the loop can restart in auto mode
      this.tick();
    }
    logger.info({ nodeId: this.nodeInfo.id, from: prev, to: mode }, "Run mode changed");
  }

  private isRunning(): boolean {
    return this.running;
  }

  private waitForTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.manualTickResolve = resolve;
    });
  }

  private async runIteration(): Promise<void> {
    this.iteration++;

    const messages = this.bus.getUnreadMessages(this.nodeInfo.id);
    const ctx = this.buildContext(messages);

    try {
      await this.handler(ctx);
    } catch (err) {
      logger.error(
        { err, node: this.nodeInfo.name, iteration: this.iteration },
        "Handler error",
      );
    }

    if (!this.intervalMs) {
      this.throttle.onIteration(messages.length > 0);
    }
  }

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
        bus.publish({
          ...msg,
          from: nodeId,
          topic,
        });
      },

      subscribe(topic: string, mailbox?: Partial<MailboxConfig>): void {
        bus.subscribe(nodeId, topic, { mailbox });
      },

      unsubscribe(topic: string): void {
        bus.unsubscribe(nodeId, topic);
      },

      sleep(conditions: WakeCondition[]): void {
        self.sleepRequested = true;
        self.sleepConditions = conditions;
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
      node: { ...self.nodeInfo },
      iteration: self.iteration,
      wasPreempted: false,
      preemptionContext: undefined,
    };
  }

  private async enterSleep(conditions: WakeCondition[]): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepService.registerSleep(
        this.nodeInfo.id,
        conditions,
        () => {
          resolve();
        },
      );
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeResolve = resolve;
      setTimeout(() => {
        this.wakeResolve = undefined;
        resolve();
      }, ms);
    });
  }
}
