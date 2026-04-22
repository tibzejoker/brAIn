import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { NodeHandler, TextPayload, Message } from "@brain/sdk";
import { CLIRegistry } from "@brain/core";
import { NODE_TEMPLATE_DOCS } from "./template";
import { v4 as uuid } from "uuid";

interface DevConfig {
  cli: string;
  timeout_ms: number;
  max_attempts: number;
}

interface WorkspaceMeta {
  slug: string;
  path: string;
  caller?: string;
  attempts: number;
  request: string;
}

interface WorkspacesState {
  [slug: string]: WorkspaceMeta;
}

interface ValidationPayload {
  slug?: string;
  type_name?: string;
  phase?: string;
  errors?: string;
  path?: string;
}

function getConfig(overrides: Record<string, unknown>): DevConfig {
  return {
    cli: (overrides.cli as string | undefined) ?? "claude",
    timeout_ms: (overrides.timeout_ms as number | undefined) ?? 300_000,
    max_attempts: (overrides.max_attempts as number | undefined) ?? 3,
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

function getWorkspaces(state: Record<string, unknown>): WorkspacesState {
  if (!state.workspaces) state.workspaces = {};
  return state.workspaces as WorkspacesState;
}

function parseValidationPayload(msg: Message): ValidationPayload {
  const content = (msg.payload as TextPayload).content;
  try {
    return JSON.parse(content) as ValidationPayload;
  } catch {
    return {};
  }
}

function runCli(
  cli: string,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const tmpFile = path.join(cwd, ".prompt.tmp");
    fs.writeFileSync(tmpFile, prompt, "utf-8");

    const proc = spawn(
      "sh",
      ["-c", `cat "${tmpFile}" | ${cli} -p - --max-turns 40 --dangerously-skip-permissions`],
      { cwd, timeout: timeoutMs },
    );

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n").filter(Boolean)) onLine(line);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) onLine(`[stderr] ${line}`);
    });
    proc.on("close", (code) => {
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

function buildInitialPrompt(workspacePath: string, request: string): string {
  return `You are authoring a new brAIn node in: ${workspacePath}

${NODE_TEMPLATE_DOCS}

## Requested node
${request}

## Instructions
1. Create ALL required files (config.json, package.json, tsconfig.json, vitest.config.ts, src/handler.ts, tests/handler.test.ts) in ${workspacePath}.
2. Run: cd ${workspacePath} && pnpm install --no-frozen-lockfile && npx tsc && npx vitest run
3. Fix any compile or test errors, rebuild, retest until all pass.
4. Stop when \`dist/handler.js\` exists and \`npx vitest run\` exits 0.

Do NOT explain; just author and build. Do not attempt to register or spawn — the framework does that automatically once your build and tests pass.`;
}

function buildRetryPrompt(workspacePath: string, request: string, phase: string, errors: string): string {
  return `You previously attempted to create a brAIn node in ${workspacePath}. The framework's automatic validation rejected it.

## Original request
${request}

## Validation phase that failed
${phase}

## Errors reported by the framework
\`\`\`
${errors.slice(0, 6000)}
\`\`\`

## Your task
Fix the workspace in ${workspacePath} so validation passes. Do not create a new workspace.
Re-read the existing files, address the errors, rebuild (\`npx tsc\`), rerun tests (\`npx vitest run\`).
Remember: tests are MANDATORY, at least one test must pass, no \`console.log\`, no \`any\`.

${NODE_TEMPLATE_DOCS}`;
}

async function runWorkspaceJob(
  ctx: Parameters<NodeHandler>[0],
  ws: WorkspaceMeta,
  prompt: string,
  config: DevConfig,
): Promise<void> {
  ws.attempts += 1;
  ctx.log("info", `[${ws.slug}] attempt ${ws.attempts}/${config.max_attempts}`);
  const result = await runCli(config.cli, prompt, path.dirname(ws.path), config.timeout_ms, (line) => {
    ctx.log("debug", `[${ws.slug}] ${line.slice(0, 200)}`);
  });
  ctx.log("info", `[${ws.slug}] CLI exit ${result.exitCode}`);
}

async function handleNewRequest(
  ctx: Parameters<NodeHandler>[0],
  msg: Message,
  workspaces: WorkspacesState,
  config: DevConfig,
  cliRegistry: CLIRegistry,
  monorepoRoot: string,
): Promise<void> {
  const payload = msg.payload as TextPayload;
  const request = payload.content;
  if (!request) return;

  if (!cliRegistry.isAvailable(config.cli)) {
    ctx.log("error", `CLI ${config.cli} not available`);
    ctx.respond(JSON.stringify({
      error: `CLI unavailable: ${config.cli}`,
      available: cliRegistry.getAvailableCLIs(),
    }));
    return;
  }

  const slug = `dev-${uuid().slice(0, 8)}`;
  const dynamicDir = path.join(monorepoRoot, "nodes", "_dynamic");
  if (!fs.existsSync(dynamicDir)) fs.mkdirSync(dynamicDir, { recursive: true });
  const workspacePath = path.join(dynamicDir, slug);
  fs.mkdirSync(workspacePath, { recursive: true });

  const ws: WorkspaceMeta = {
    slug, path: workspacePath,
    caller: msg.from, attempts: 0, request,
  };
  workspaces[slug] = ws;
  ctx.log("info", `Creating workspace ${slug}`);
  await runWorkspaceJob(ctx, ws, buildInitialPrompt(workspacePath, request), config);
  // After CLI returns, framework scanner picks up the build; we stay running,
  // waiting for types.registered or types.validation_failed.
}

async function handleValidationFeedback(
  ctx: Parameters<NodeHandler>[0],
  msg: Message,
  workspaces: WorkspacesState,
  config: DevConfig,
): Promise<void> {
  const data = parseValidationPayload(msg);
  if (!data.slug || !(data.slug in workspaces)) return;
  const ws = workspaces[data.slug];

  if (msg.topic === "types.registered" || msg.topic === "types.updated") {
    ctx.log("info", `[${ws.slug}] registered as '${data.type_name ?? "?"}'`);
    ctx.respond(JSON.stringify({
      status: "success",
      slug: ws.slug,
      type_name: data.type_name,
      path: ws.path,
      attempts: ws.attempts,
    }));
    delete workspaces[ws.slug];
    return;
  }

  if (msg.topic === "types.validation_failed") {
    ctx.log("warn", `[${ws.slug}] validation failed (${data.phase}) attempt ${ws.attempts}/${config.max_attempts}`);
    if (ws.attempts >= config.max_attempts) {
      ctx.log("error", `[${ws.slug}] giving up after ${ws.attempts} attempts`);
      ctx.respond(JSON.stringify({
        status: "failed",
        slug: ws.slug,
        path: ws.path,
        phase: data.phase,
        errors: data.errors?.slice(0, 2000),
        attempts: ws.attempts,
      }));
      delete workspaces[ws.slug];
      return;
    }
    await runWorkspaceJob(ctx, ws, buildRetryPrompt(ws.path, ws.request, data.phase ?? "unknown", data.errors ?? ""), config);
  }
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {});
  const cliRegistry = CLIRegistry.getInstance();
  await cliRegistry.initialize();
  const monorepoRoot = resolveMonorepoRoot();
  const workspaces = getWorkspaces(ctx.state);

  for (const msg of ctx.messages) {
    if (msg.topic.startsWith("types.")) {
      await handleValidationFeedback(ctx, msg, workspaces, config);
    } else {
      await handleNewRequest(ctx, msg, workspaces, config, cliRegistry, monorepoRoot);
    }
  }
};
