import { exec } from "child_process";
import type { NodeHandler, TextPayload } from "@brain/sdk";
import { CLIRegistry } from "@brain/core";

interface CLIConfig {
  cli: string;
  response_topic: string;
  timeout_ms: number;
  cwd: string;
  max_output: number;
}

function getConfig(overrides: Record<string, unknown>): CLIConfig {
  return {
    cli: (overrides.cli as string | undefined) ?? "claude",
    response_topic: (overrides.response_topic as string | undefined) ?? "llm.cli.response",
    timeout_ms: (overrides.timeout_ms as number | undefined) ?? 120000,
    cwd: (overrides.cwd as string | undefined) ?? process.cwd(),
    max_output: (overrides.max_output as number | undefined) ?? 50000,
  };
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: err ? (err.code ?? 1) : 0,
      });
    });
  });
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const registry = CLIRegistry.getInstance();

  if (!registry.isAvailable(config.cli)) {
    ctx.publish(config.response_topic, {
      type: "alert",
      criticality: 5,
      payload: {
        title: `CLI agent unavailable: ${config.cli}`,
        description: `The ${config.cli} CLI is not installed or not in PATH. Available: ${registry.getAvailableCLIs().join(", ") || "none"}`,
      },
    });
    return;
  }

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const prompt = payload.content;
    if (!prompt) continue;

    const command = registry.buildCommand(config.cli, prompt);

    try {
      const result = await execCommand(command, config.cwd, config.timeout_ms);

      const output = result.stdout || result.stderr;
      const truncated = output.length > config.max_output
        ? `${output.slice(0, config.max_output)}\n... (truncated)`
        : output;

      // Try to parse JSON output (Claude and Gemini return JSON)
      let parsedContent = truncated;
      try {
        const parsed = JSON.parse(truncated) as Record<string, unknown>;
        if (typeof parsed.result === "string") {
          parsedContent = parsed.result;
        } else if (typeof parsed.response === "string") {
          parsedContent = parsed.response;
        }
      } catch {
        // Not JSON, use raw output
      }

      ctx.publish(config.response_topic, {
        type: "text",
        criticality: msg.criticality,
        payload: { content: parsedContent },
        metadata: {
          cli: config.cli,
          exit_code: result.exitCode,
          original_topic: msg.topic,
          original_message_id: msg.id,
        },
      });
    } catch (err) {
      ctx.publish(config.response_topic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: `CLI execution failed: ${config.cli}`,
          description: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
};
