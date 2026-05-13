import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, RunMode } from "@brain/sdk";
import { BaseRunner, type RunnerDeps } from "./base-runner";

const DEFAULT_MAX_ITERATIONS = 5;

/**
 * LLMRunner — for LLM-powered nodes (brain, analyst, memory-proxy, etc.)
 *
 * Execution: budget-based loop within a single wake.
 *   - The handler is called repeatedly while new messages arrive AND
 *     the per-wake budget allows further steps.
 *   - Budget info is injected into ctx.state so the handler/prompt can
 *     observe how many steps remain.
 *   - When the budget is exhausted or the mailbox is empty, the loop
 *     ends and the runner parks until the next bus message lands.
 *
 * This is the classic agentic loop: react to a message, run as many
 * tool steps as needed, return. No timer-based wake — periodic work
 * subscribes to a clock/cron tick.
 */
export class LLMRunner extends BaseRunner {
  private readonly maxIterations: number;

  constructor(
    nodeInfo: NodeInfo,
    handler: NodeHandler,
    deps: RunnerDeps,
    runMode?: RunMode,
    teardown?: NodeTeardown,
    onSpawn?: NodeOnSpawn,
  ) {
    super(nodeInfo, handler, deps, runMode, teardown, onSpawn);
    this.maxIterations = typeof nodeInfo.config_overrides?.max_iterations === "number"
      ? nodeInfo.config_overrides.max_iterations
      : DEFAULT_MAX_ITERATIONS;
  }

  protected async executionLoop(): Promise<void> {
    let budget = this.maxIterations;

    while (budget > 0) {
      // Each fresh batch of inbound messages resets attention budget,
      // so the handler can chain steps in response to its own publishes
      // (e.g. delegating a tool then narrating the result).
      if (this.deps.bus.hasUnreadMessages(this.nodeInfo.id)) {
        budget = this.maxIterations;
      } else if (this.iteration > 0) {
        // No messages and we've already run at least once — done.
        return;
      }

      this.injectBudget(budget);
      await this.runHandler();
      budget--;
    }

    this.log.info(`Budget exhausted (${this.maxIterations} iterations)`);
  }

  private injectBudget(budget: number): void {
    const current = this.maxIterations - budget + 1;
    this.state._iteration = current;
    this.state._iterations_remaining = budget;
    this.state._iterations_total = this.maxIterations;

    const budgetHint = budget <= 3
      ? `You will be parked after ${budget} more iteration(s). Wrap up.`
      : `You have ${budget} iterations remaining.`;

    this.state._system_hint = `[system: iteration ${current}/${this.maxIterations}. ${budgetHint}]`;
  }
}
