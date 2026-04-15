import { exec } from "child_process";
import type { NodeHandler, TextPayload } from "@brain/sdk";

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
      resolve({ stdout, stderr, exitCode: err ? (err.code ?? 1) : 0 });
    });
  });
}

export const handler: NodeHandler = async (ctx) => {
  const overrides = ctx.node.config_overrides ?? {} as Record<string, unknown>;
  const allowedCommands = overrides.allowed_commands as string[] | undefined;
  const cwd = overrides.cwd as string | undefined;
  const timeoutMs = (overrides.timeout_ms as number | undefined) ?? 30000;
  const maxOutput = (overrides.max_output as number | undefined) ?? 10000;

  for (const msg of ctx.messages) {
    const command = (msg.payload as TextPayload).content.trim();
    if (!command) continue;

    if (!isAllowed(command, allowedCommands)) {
      ctx.respond(JSON.stringify({
        error: `Command not in allowed list: ${command.split(/\s+/)[0]}`,
      }));
      continue;
    }

    const result = await execCommand(command, cwd, timeoutMs);
    const output = result.stdout || result.stderr;
    const truncated = output.length > maxOutput ? `${output.slice(0, maxOutput)}\n... (truncated)` : output;

    ctx.respond(JSON.stringify({
      command,
      exit_code: result.exitCode,
      stdout: result.stdout ? truncated : undefined,
      stderr: result.stderr ? result.stderr.slice(0, 2000) : undefined,
    }), { exit_code: result.exitCode });
  }
};
