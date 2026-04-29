import type { NodeInfo, NodeHandler, NodeOnSpawn, NodeTeardown, RunMode } from "@brain/sdk";
import type { BaseRunner, RunnerDeps } from "./base-runner";
import { ServiceRunner } from "./service-runner";
import { LLMRunner } from "./llm-runner";
import { WebRunner } from "./web-runner";

export enum RunnerType {
  SERVICE = "service",
  LLM = "llm",
  WEB = "web",
}

/**
 * Determine runner type. Web wins over LLM/service when the node was
 * spawned with `transport: "web"` (or carries a `web` block in
 * config_overrides). Tags fall through to the legacy LLM/service split.
 */
export function resolveRunnerType(nodeInfo: NodeInfo): RunnerType {
  if (nodeInfo.transport === "web" || nodeInfo.config_overrides?.web) return RunnerType.WEB;
  if (nodeInfo.tags.includes("llm")) return RunnerType.LLM;
  return RunnerType.SERVICE;
}

const RUNNER_MAP: Record<RunnerType, new (
  nodeInfo: NodeInfo,
  handler: NodeHandler,
  deps: RunnerDeps,
  runMode?: RunMode,
  teardown?: NodeTeardown,
  onSpawn?: NodeOnSpawn,
) => BaseRunner> = {
  [RunnerType.SERVICE]: ServiceRunner,
  [RunnerType.LLM]: LLMRunner,
  [RunnerType.WEB]: WebRunner,
};

/** Creates the appropriate runner based on node transport + tags. */
export function createRunner(
  nodeInfo: NodeInfo,
  handler: NodeHandler,
  deps: RunnerDeps,
  runMode?: RunMode,
  teardown?: NodeTeardown,
  onSpawn?: NodeOnSpawn,
): BaseRunner {
  const type = resolveRunnerType(nodeInfo);
  const RunnerClass = RUNNER_MAP[type];
  return new RunnerClass(nodeInfo, handler, deps, runMode, teardown, onSpawn);
}
