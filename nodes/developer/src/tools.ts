import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { logger } from "@brain/core";

const log = logger.child({ node: "developer" });

export interface ToolResult {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export function executeDevTool(
  toolName: string,
  args: Record<string, unknown>,
  workspacePath: string,
  monorepoRoot: string,
): Promise<ToolResult> {
  switch (toolName) {
    case "write_file":
      return writeFile(workspacePath, args.filepath as string, args.content as string);
    case "read_file":
      return readFile(workspacePath, args.filepath as string);
    case "build_and_validate":
      return buildAndValidate(workspacePath);
    case "register_type":
      return registerType(workspacePath, args.name as string);
    case "list_existing_types":
      return listExistingTypes(monorepoRoot);
    default:
      return Promise.resolve({ error: `Unknown tool: ${toolName}` });
  }
}

export const TOOL_DESCRIPTIONS = `
Available tools:
- write_file(filepath, content): Write a file to the workspace. Use relative paths like "src/handler.ts".
- read_file(filepath): Read a file from the workspace.
- build_and_validate(): Install deps and compile. Returns errors if any.
- register_type(name): Register the node type after successful build.
- list_existing_types(): List existing node types to avoid conflicts.

Call tools by responding with JSON in this format:
{"tool": "write_file", "args": {"filepath": "config.json", "content": "..."}}

After each tool call, you'll see the result and can continue.
When done, call register_type with the node name.
`;

function writeFile(workspace: string, filepath: string, content: string): Promise<ToolResult> {
  const fullPath = path.join(workspace, filepath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content, "utf-8");
  log.info({ filepath }, "Wrote file");
  return Promise.resolve({ success: true, path: filepath });
}

function readFile(workspace: string, filepath: string): Promise<ToolResult> {
  const fullPath = path.join(workspace, filepath);
  if (!fs.existsSync(fullPath)) {
    return Promise.resolve({ error: `File not found: ${filepath}` });
  }
  return Promise.resolve({ content: fs.readFileSync(fullPath, "utf-8") });
}

async function buildAndValidate(workspace: string): Promise<ToolResult> {
  const installResult = await runCommand(`cd "${workspace}" && pnpm install --no-frozen-lockfile 2>&1`, 60000);
  if (installResult.exitCode !== 0) {
    return { success: false, phase: "install", error: (installResult.stderr || installResult.stdout).slice(0, 2000) };
  }

  const buildResult = await runCommand(`cd "${workspace}" && npx tsc 2>&1`, 30000);
  if (buildResult.exitCode !== 0) {
    return { success: false, phase: "compile", errors: buildResult.stdout.slice(0, 2000) };
  }

  log.info("Build successful");
  return { success: true };
}

function registerType(workspace: string, name: string): Promise<ToolResult> {
  if (!fs.existsSync(path.join(workspace, "config.json"))) {
    return Promise.resolve({ error: "config.json not found" });
  }
  if (!fs.existsSync(path.join(workspace, "dist", "handler.js"))) {
    return Promise.resolve({ error: "dist/handler.js not found — run build_and_validate first" });
  }
  log.info({ name, path: workspace }, "Node type ready to register");
  return Promise.resolve({ success: true, name, path: workspace });
}

function listExistingTypes(monorepoRoot: string): Promise<ToolResult> {
  const nodesDir = path.join(monorepoRoot, "nodes");
  const entries = fs.readdirSync(nodesDir, { withFileTypes: true });
  const types = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => {
      const cfgPath = path.join(nodesDir, e.name, "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as { name: string; description: string };
        return { name: cfg.name, description: cfg.description };
      }
      return { name: e.name, description: "unknown" };
    });
  return Promise.resolve({ types });
}

function runCommand(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (err.code ?? 1) : 0 });
    });
  });
}
