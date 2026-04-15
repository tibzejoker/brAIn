import type { NodeInfo, NodeHandler, RunMode } from "@brain/sdk";
import { BaseRunner, type RunnerDeps } from "./base-runner";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_FORCED_SLEEP = "30s";

/**
 * LLMRunner — for LLM-powered nodes (brain, analyst, memory-proxy, etc.)
 *
 * Execution: budget-based loop.
 *   - Each new message resets the iteration budget.
 *   - The handler is called repeatedly until it sleeps or budget runs out.
 *   - Budget info is injected into ctx.state so the handler/prompt can see it.
 *   - On budget exhaustion → forced sleep (configurable duration).
 */
export class LLMRunner extends BaseRunner {
  private readonly maxIterations: number;
  private readonly forcedSleepDuration: string;

  constructor(
    nodeInfo: NodeInfo,
    handler: NodeHandler,
    deps: RunnerDeps,
    runMode?: RunMode,
  ) {
    super(nodeInfo, handler, deps, runMode);
    this.maxIterations = typeof nodeInfo.config_overrides?.max_iterations === "number"
      ? nodeInfo.config_overrides.max_iterations
      : DEFAULT_MAX_ITERATIONS;
    this.forcedSleepDuration = typeof nodeInfo.config_overrides?.forced_sleep === "string"
      ? nodeInfo.config_overrides.forced_sleep
      : DEFAULT_FORCED_SLEEP;
  }

  protected async executionLoop(): Promise<void> {
    let budget = this.maxIterations;

    while (budget > 0) {
      // New messages reset attention budget
      if (this.deps.bus.hasUnreadMessages(this.nodeInfo.id)) {
        budget = this.maxIterations;
      }

      // Inject context for the handler/prompt
      this.injectBudget(budget);

      await this.runHandler();
      budget--;

      // Handler chose to sleep — respect it
      if (this.sleepRequested) {
        this.enterSleep();
        return;
      }
    }

    // Budget exhausted
    this.log.info(`Budget exhausted (${this.maxIterations} iterations), forcing sleep`);
    this.forceSleep(this.forcedSleepDuration);
  }

  private injectBudget(budget: number): void {
    const current = this.maxIterations - budget + 1;
    this.state._iteration = current;
    this.state._iterations_remaining = budget;
    this.state._iterations_total = this.maxIterations;

    // Wake context for LLM handlers
    const wakeReason = this.state._wake_reason as string | undefined ?? "unknown";
    const wakeLabel = current === 1
      ? (wakeReason === "timer" ? "You woke up from a scheduled timer."
        : wakeReason === "message" ? "You were woken by a new message."
        : "You are starting up.")
      : "";

    // Budget hint
    const budgetHint = budget <= 3
      ? `You will be put to sleep in ${budget} iteration(s). Wrap up or sleep voluntarily.`
      : `You have ${budget} iterations remaining. Use tools, act, or sleep when done.`;

    this.state._system_hint = `[system: ${wakeLabel} iteration ${current}/${this.maxIterations}. ${budgetHint}]`;
  }
}
