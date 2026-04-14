import { BaseRunner } from "./base-runner";

/**
 * ServiceRunner — for reactive, non-LLM nodes (memory, http-bridge, terminal, etc.)
 *
 * Execution: process all pending messages in one handler call, then auto-sleep.
 * Wakes on any new message.
 */
export class ServiceRunner extends BaseRunner {
  protected async executionLoop(): Promise<void> {
    await this.runHandler();

    // Respect explicit sleep from handler, otherwise auto-sleep
    if (this.sleepRequested) {
      this.enterSleep();
    } else {
      this.autoSleep();
    }
  }
}
