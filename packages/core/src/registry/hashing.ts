import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface WorkspaceHashes {
  source_hash: string;
  build_hash: string;
  deps_hash: string;
}

/**
 * Compute deterministic hashes for a node workspace.
 * - source_hash covers src/** + config.json  (detects "edited but not rebuilt")
 * - build_hash covers dist/**                 (triggers re-validation)
 * - deps_hash covers package.json dependencies (triggers re-install)
 * Returns empty strings for missing segments so a comparison against a fresh
 * state object still detects changes cleanly.
 */
export function computeWorkspaceHashes(workspacePath: string): WorkspaceHashes {
  return {
    source_hash: hashDir(path.join(workspacePath, "src")) + "::" + hashFile(path.join(workspacePath, "config.json")),
    build_hash: hashDir(path.join(workspacePath, "dist")),
    deps_hash: hashDeps(path.join(workspacePath, "package.json")),
  };
}

/**
 * SHA256 of a directory, recursively, ignoring node_modules and .brain-state.json.
 * Files are hashed in a stable order (sorted by relative path) for determinism.
 */
export function hashDir(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return "";
  const hash = createHash("sha256");
  const files = collectFiles(dirPath, dirPath).sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dirPath, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectFiles(rootDir: string, currentDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".brain-state.json") continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(rootDir, full));
    } else if (entry.isFile()) {
      out.push(path.relative(rootDir, full));
    }
  }
  return out;
}

function hashFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashDeps(packageJsonPath: string): string {
  if (!fs.existsSync(packageJsonPath)) return "";
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged = {
      dependencies: sortObject(pkg.dependencies ?? {}),
      devDependencies: sortObject(pkg.devDependencies ?? {}),
    };
    return createHash("sha256").update(JSON.stringify(merged)).digest("hex");
  } catch {
    return "";
  }
}

function sortObject(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}
