import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { NodeHandler, TextPayload } from "@brain/sdk";
import { CLIRegistry, BrainService } from "@brain/core";
import { NODE_TEMPLATE_DOCS } from "./template";
import { v4 as uuid } from "uuid";

interface DevConfig {
  cli: string;
  timeout_ms: number;
}

function getConfig(overrides: Record<string, unknown>): DevConfig {
  return {
    cli: (overrides.cli as string | undefined) ?? "claude",
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

function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = path.join(cwd, ".prompt.tmp");
    fs.writeFileSync(tmpFile, prompt, "utf-8");

    const proc = spawn(
      "sh",
      ["-c", `cat "${tmpFile}" | claude -p - --max-turns 30 --dangerously-skip-permissions`],
      { cwd, timeout: timeoutMs },
    );

    let stdout = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n").filter(Boolean)) {
        onLine(line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        onLine(`[stderr] ${line}`);
      }
    });

    proc.on("close", (code) => {
      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve({ stdout, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      onLine(`[error] ${err.message}`);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
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
      ctx.respond(JSON.stringify({
        error: `CLI unavailable: ${config.cli}`,
        available: cliRegistry.getAvailableCLIs(),
      }));
      continue;
    }

    try {
      ctx.log("info", `Running ${config.cli} with streaming...`);
      const result = await runClaude(
        prompt,
        monorepoRoot,
        config.timeout_ms,
        (line) => {
          ctx.log("debug", line.slice(0, 200));
        },
      );
      ctx.log("info", `CLI exit code: ${result.exitCode}`);

      // Check if the build succeeded
      const configPath = path.join(workspacePath, "config.json");
      const handlerPath = path.join(workspacePath, "dist", "handler.js");

      if (fs.existsSync(configPath) && fs.existsSync(handlerPath)) {
        const nodeConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          name: string;
          default_subscriptions?: Array<{ topic: string }>;
        };
        ctx.log("info", `Node type '${nodeConfig.name}' created, registering...`);

        // Register the new type in the framework
        const brain = BrainService.current;
        let spawned = false;
        if (brain) {
          try {
            brain.typeRegistry.register(workspacePath);
            ctx.log("info", `Type '${nodeConfig.name}' registered`);

            // Auto-spawn an instance
            await brain.spawnNode({
              type: nodeConfig.name,
              name: nodeConfig.name,
              subscriptions: nodeConfig.default_subscriptions,
            });
            spawned = true;
            ctx.log("info", `Instance '${nodeConfig.name}' spawned and running`);
          } catch (regErr) {
            ctx.log("error", `Registration/spawn failed: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
          }
        }

        ctx.respond(JSON.stringify({
          status: "success",
          type_name: nodeConfig.name,
          type_path: workspacePath,
          registered: Boolean(brain),
          spawned,
          message: `Node type '${nodeConfig.name}' created${spawned ? " and running" : ""}.`,
        }), { workspace: workspacePath });
      } else {
        // List what was created for debugging
        const files = fs.existsSync(workspacePath)
          ? fs.readdirSync(workspacePath, { recursive: true }).map(String).join(", ")
          : "empty";

        ctx.log("warn", `Build incomplete. Files: ${files}`);
        ctx.respond(JSON.stringify({
          error: "Node creation incomplete",
          details: `Build did not produce dist/handler.js. Files: ${files}`,
          cli_output: result.stdout.slice(0, 200),
        }), { workspace: workspacePath });
      }
    } catch (err) {
      ctx.log("error", `Failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.respond(JSON.stringify({
        error: `Developer node failed: ${err instanceof Error ? err.message : String(err)}`,
      }), { workspace: workspacePath });
    }
  }
};
