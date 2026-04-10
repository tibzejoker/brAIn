import { exec } from "child_process";
import type { NodeHandler, TextPayload } from "@brain/sdk";

interface TerminalConfig {
  response_topic?: string;
  cwd?: string;
  timeout_ms?: number;
  max_output?: number;
  allowed_commands?: string[];
}

function getConfig(overrides: Record<string, unknown>): TerminalConfig {
  return {
    response_topic: overrides.response_topic as string | undefined,
    cwd: overrides.cwd as string | undefined,
    timeout_ms: (overrides.timeout_ms as number | undefined) ?? 30000,
    max_output: (overrides.max_output as number | undefined) ?? 10000,
    allowed_commands: overrides.allowed_commands as string[] | undefined,
  };
}

function isAllowed(command: string, allowList: string[] | undefined): boolean {
  if (!allowList) return true;
  const bin = command.trim().split(/\s+/)[0];
  return allowList.some((a) => bin === a || command.startsWith(a));
}

function execCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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
  const responseTopic = config.response_topic ?? `terminal.output.${ctx.node.name}`;

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const command = payload.content.trim();
    if (!command) continue;

    // Security check
    if (!isAllowed(command, config.allowed_commands)) {
      ctx.publish(responseTopic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: "Command blocked",
          description: `Command not in allowed list: ${command.split(/\s+/)[0]}`,
        },
      });
      continue;
    }

    const result = await execCommand(command, config.cwd, config.timeout_ms ?? 30000);

    const output = result.stdout || result.stderr;
    const truncated = output.length > (config.max_output ?? 10000)
      ? `${output.slice(0, config.max_output ?? 10000)}\n... (truncated)`
      : output;

    ctx.publish(responseTopic, {
      type: "text",
      criticality: result.exitCode === 0 ? msg.criticality : 4,
      payload: {
        content: JSON.stringify({
          command,
          exit_code: result.exitCode,
          stdout: result.stdout ? truncated : undefined,
          stderr: result.stderr ? result.stderr.slice(0, 2000) : undefined,
        }),
      },
      metadata: {
        original_topic: msg.topic,
        original_message_id: msg.id,
        exit_code: result.exitCode,
      },
    });
  }
};
