import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { NodeHandler, TextPayload } from "@brain/sdk";
import { CLIRegistry } from "@brain/core";
import { NODE_TEMPLATE_DOCS } from "./template";
import { v4 as uuid } from "uuid";

interface DevConfig {
  cli: string;
  response_topic: string;
  timeout_ms: number;
}

function getConfig(overrides: Record<string, unknown>): DevConfig {
  return {
    cli: (overrides.cli as string | undefined) ?? "claude",
    response_topic: (overrides.response_topic as string | undefined) ?? "dev.result",
    timeout_ms: (overrides.timeout_ms as number | undefined) ?? 300000,
  };
}

function resolveMonorepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function runCommandStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, timeout: timeoutMs });
    let stdout = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n").filter(Boolean)) {
        onLine(line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n").filter(Boolean)) {
        onLine(`[stderr] ${line}`);
      }
    });

    proc.on("close", (code) => {
      resolve({ stdout, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      onLine(`[error] ${err.message}`);
      resolve({ stdout, exitCode: 1 });
    });
  });
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const cliRegistry = CLIRegistry.getInstance();
  await cliRegistry.initialize();

  const monorepoRoot = resolveMonorepoRoot();

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const request = payload.content;
    if (!request) continue;

    // Create workspace
    const workspaceId = uuid().slice(0, 8);
    const dynamicDir = path.join(monorepoRoot, "nodes", "_dynamic");
    if (!fs.existsSync(dynamicDir)) fs.mkdirSync(dynamicDir, { recursive: true });
    const workspacePath = path.join(dynamicDir, `dev-${workspaceId}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    ctx.log("info", `Creating node in ${workspacePath}`);

    // Build the prompt for Claude Code
    const prompt = `You are creating a new brAIn node package in the directory: ${workspacePath}

${NODE_TEMPLATE_DOCS}

## Your task
${request}

## Instructions
1. Create ALL required files in ${workspacePath}: config.json, package.json, tsconfig.json, src/handler.ts
2. Run: cd ${workspacePath} && pnpm install --no-frozen-lockfile && npx tsc
3. If there are compile errors, fix them and rebuild
4. Verify dist/handler.js exists

Do NOT explain, just create the files and build. Work entirely in ${workspacePath}.`;

    if (!cliRegistry.isAvailable(config.cli)) {
      ctx.log("error", `CLI ${config.cli} not available`);
      ctx.publish(config.response_topic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: "Developer: CLI unavailable",
          description: `${config.cli} is not installed. Available: ${cliRegistry.getAvailableCLIs().join(", ") || "none"}`,
        },
      });
      continue;
    }

    try {
      const escaped = prompt.replace(/'/g, "'\\''");

      ctx.log("info", `Running ${config.cli} with streaming...`);
      const result = await runCommandStreamed(
        "claude",
        ["-p", prompt, "--max-turns", "10", "--dangerously-skip-permissions"],
        monorepoRoot,
        config.timeout_ms,
        (line) => {
          // Stream each line into the node log
          ctx.log("debug", line.slice(0, 200));
        },
      );
      ctx.log("info", `CLI exit code: ${result.exitCode}`);

      // Check if the build succeeded
      const configPath = path.join(workspacePath, "config.json");
      const handlerPath = path.join(workspacePath, "dist", "handler.js");

      if (fs.existsSync(configPath) && fs.existsSync(handlerPath)) {
        const nodeConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { name: string };
        ctx.log("info", `Node type '${nodeConfig.name}' created successfully`);

        ctx.publish(config.response_topic, {
          type: "text",
          criticality: 5,
          payload: {
            content: JSON.stringify({
              status: "success",
              type_name: nodeConfig.name,
              type_path: workspacePath,
              message: `Node type '${nodeConfig.name}' created. Register it to start using.`,
            }),
          },
          metadata: { workspace: workspacePath },
        });
      } else {
        // List what was created for debugging
        const files = fs.existsSync(workspacePath)
          ? fs.readdirSync(workspacePath, { recursive: true }).map(String).join(", ")
          : "empty";

        ctx.log("warn", `Build incomplete. Files: ${files}`);
        ctx.publish(config.response_topic, {
          type: "alert",
          criticality: 4,
          payload: {
            title: "Node creation incomplete",
            description: `Build did not produce dist/handler.js. Files: ${files}. CLI output: ${result.stdout.slice(0, 200)}`,
          },
          metadata: { workspace: workspacePath },
        });
      }
    } catch (err) {
      ctx.log("error", `Failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.publish(config.response_topic, {
        type: "alert",
        criticality: 5,
        payload: {
          title: "Developer node failed",
          description: err instanceof Error ? err.message : String(err),
        },
        metadata: { workspace: workspacePath },
      });
    }
  }
};
