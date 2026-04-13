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
    case "replace_lines":
      return replaceLines(workspacePath, args.filepath as string, args.start as number, args.end as number, args.content as string);
    case "insert_lines":
      return insertLines(workspacePath, args.filepath as string, args.after as number, args.content as string);
    case "delete_lines":
      return deleteLines(workspacePath, args.filepath as string, args.start as number, args.end as number);
    case "search_file":
      return searchFile(workspacePath, args.filepath as string, args.pattern as string);
    case "list_existing_types":
      return listExistingTypes(monorepoRoot);
    default:
      return Promise.resolve({ error: `Unknown tool: ${toolName}` });
  }
}

export const TOOL_DESCRIPTIONS = `
Available tools:

## File creation
- write_file(filepath, content): Write/overwrite a file. Use for new files.
- read_file(filepath): Read a file. Output shows line numbers (e.g. "  1| code here").

## File editing (line-based)
- replace_lines(filepath, start, end, content): Replace lines start..end (inclusive, 1-based) with new content.
- insert_lines(filepath, after, content): Insert content after line number (0 = beginning of file).
- delete_lines(filepath, start, end): Delete lines start..end (inclusive, 1-based).
- search_file(filepath, pattern): Search for a regex pattern. Returns matching lines with line numbers.

## Build
- build_and_validate(): Install deps and compile. Returns errors if any.
- register_type(name): Register the node type after successful build.
- list_existing_types(): List existing node types to avoid conflicts.

Call tools with JSON: {"tool": "tool_name", "args": {"key": "value"}}
After each tool call, you'll see the result. When build succeeds, call register_type.
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
  const raw = fs.readFileSync(fullPath, "utf-8");
  const numbered = raw
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)}| ${line}`)
    .join("\n");
  return Promise.resolve({ content: numbered, total_lines: raw.split("\n").length });
}

interface FileLines {
  lines: string[];
  fullPath: string;
}

function getLines(workspace: string, filepath: string): FileLines | null {
  const fullPath = path.join(workspace, filepath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return { lines: fs.readFileSync(fullPath, "utf-8").split("\n"), fullPath };
}

function replaceLines(workspace: string, filepath: string, start: number, end: number, content: string): Promise<ToolResult> {
  const result = getLines(workspace, filepath);
  if (!result) return Promise.resolve({ error: `File not found: ${filepath}` });
  const { lines, fullPath } = result;

  if (start < 1 || end > lines.length || start > end) {
    return Promise.resolve({ error: `Invalid range ${start}-${end}. File has ${lines.length} lines.` });
  }

  const newLines = content.split("\n");
  lines.splice(start - 1, end - start + 1, ...newLines);
  fs.writeFileSync(fullPath, lines.join("\n"), "utf-8");
  log.info({ filepath, start, end, inserted: newLines.length }, "Replaced lines");
  return Promise.resolve({ success: true, lines_removed: end - start + 1, lines_inserted: newLines.length, total_lines: lines.length });
}

function insertLines(workspace: string, filepath: string, after: number, content: string): Promise<ToolResult> {
  const result = getLines(workspace, filepath);
  if (!result) return Promise.resolve({ error: `File not found: ${filepath}` });
  const { lines, fullPath } = result;

  if (after < 0 || after > lines.length) {
    return Promise.resolve({ error: `Invalid position ${after}. File has ${lines.length} lines. Use 0 for beginning.` });
  }

  const newLines = content.split("\n");
  lines.splice(after, 0, ...newLines);
  fs.writeFileSync(fullPath, lines.join("\n"), "utf-8");
  log.info({ filepath, after, inserted: newLines.length }, "Inserted lines");
  return Promise.resolve({ success: true, lines_inserted: newLines.length, total_lines: lines.length });
}

function deleteLines(workspace: string, filepath: string, start: number, end: number): Promise<ToolResult> {
  const result = getLines(workspace, filepath);
  if (!result) return Promise.resolve({ error: `File not found: ${filepath}` });
  const { lines, fullPath } = result;

  if (start < 1 || end > lines.length || start > end) {
    return Promise.resolve({ error: `Invalid range ${start}-${end}. File has ${lines.length} lines.` });
  }

  lines.splice(start - 1, end - start + 1);
  fs.writeFileSync(fullPath, lines.join("\n"), "utf-8");
  log.info({ filepath, start, end }, "Deleted lines");
  return Promise.resolve({ success: true, lines_removed: end - start + 1, total_lines: lines.length });
}

function searchFile(workspace: string, filepath: string, pattern: string): Promise<ToolResult> {
  const result = getLines(workspace, filepath);
  if (!result) return Promise.resolve({ error: `File not found: ${filepath}` });
  const { lines } = result;

  const regex = new RegExp(pattern, "gi");
  const matches = lines
    .map((line, i) => ({ line: i + 1, content: line }))
    .filter((entry) => regex.test(entry.content));

  return Promise.resolve({
    matches: matches.map((m) => `${String(m.line).padStart(4)}| ${m.content}`),
    count: matches.length,
  });
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
