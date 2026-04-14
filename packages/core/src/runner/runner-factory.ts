import type { NodeInfo, NodeHandler, RunMode } from "@brain/sdk";
import type { BaseRunner, RunnerDeps } from "./base-runner";
import { ServiceRunner } from "./service-runner";
import { LLMRunner } from "./llm-runner";

export enum RunnerType {
  SERVICE = "service",
  LLM = "llm",
}

/** Determine runner type from node tags. */
export function resolveRunnerType(tags: string[]): RunnerType {
  if (tags.includes("llm")) return RunnerType.LLM;
  return RunnerType.SERVICE;
}

const RUNNER_MAP: Record<RunnerType, new (
  nodeInfo: NodeInfo,
  handler: NodeHandler,
  deps: RunnerDeps,
  runMode?: RunMode,
) => BaseRunner> = {
  [RunnerType.SERVICE]: ServiceRunner,
  [RunnerType.LLM]: LLMRunner,
};

/** Creates the appropriate runner based on node tags. */
export function createRunner(
  nodeInfo: NodeInfo,
  handler: NodeHandler,
  deps: RunnerDeps,
  runMode?: RunMode,
): BaseRunner {
  const type = resolveRunnerType(nodeInfo.tags);
  const RunnerClass = RUNNER_MAP[type];
  return new RunnerClass(nodeInfo, handler, deps, runMode);
}
