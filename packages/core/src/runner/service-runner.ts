import { BaseRunner } from "./base-runner";

/**
 * ServiceRunner — for reactive, non-LLM nodes (memory, http-bridge, terminal, etc.)
 *
 * Execution: process all pending messages in one handler call, then let
 * the runner park (no work is scheduled until the next bus message).
 */
export class ServiceRunner extends BaseRunner {
  protected async executionLoop(): Promise<void> {
    await this.runHandler();
  }
}
