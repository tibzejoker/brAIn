import type { NodeTypeConfig } from "@brain/sdk";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../logger";

export class TypeRegistry {
  private readonly types = new Map<string, NodeTypeConfig>();
  private readonly typePaths = new Map<string, string>();

  register(dirPath: string): NodeTypeConfig {
    const configPath = path.join(dirPath, "config.json");
    if (!fs.existsSync(configPath)) {
      throw new Error(`No config.json found at ${configPath}`);
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    // Cast through Partial — the SDK type says these fields are
    // required, but on-disk config.json files sometimes omit them
    // (notably `default_subscriptions` on publish-only nodes like clock,
    // and minimal stub configs in dynamic-scanner tests). Treating the
    // parse as Partial<...> makes the optionality explicit and lets the
    // null-coalesce below be honest.
    const config = JSON.parse(raw) as Partial<NodeTypeConfig>;

    if (!config.name) {
      throw new Error(`config.json at ${dirPath} is missing "name" field`);
    }

    // Hard cutover (2026-05-13): every public subscription MUST declare
    // an inputSchema, or opt out with `internal: true`. Mirrors the
    // check in TypeValidatorService for dynamic node types — applied
    // here so static (in-tree + installed-package) nodes get the same
    // discipline. The single source of truth fans out to /tools, the
    // MCPBridge, publish-time validation, and ctx.tools.list().
    for (const sub of (config.default_subscriptions ?? [])) {
      const s = sub as { topic: string; description?: string; inputSchema?: unknown; internal?: boolean };
      if (s.internal === true) continue;
      if (!s.inputSchema || typeof s.inputSchema !== "object") {
        throw new Error(
          `Node "${config.name}" at ${dirPath}: subscription "${s.topic}" is missing required \`inputSchema\` (JSON Schema). ` +
          `Add the schema describing accepted payloads, or mark { "internal": true } if this is private plumbing.`,
        );
      }
      if (!s.description || typeof s.description !== "string") {
        throw new Error(
          `Node "${config.name}" at ${dirPath}: subscription "${s.topic}" is missing required 'description'.`,
        );
      }
    }

    const full = config as NodeTypeConfig;
    this.types.set(full.name, full);
    this.typePaths.set(full.name, dirPath);
    return full;
  }

  unregister(typeName: string): boolean {
    this.typePaths.delete(typeName);
    return this.types.delete(typeName);
  }

  get(typeName: string): NodeTypeConfig | undefined {
    return this.types.get(typeName);
  }

  getPath(typeName: string): string | undefined {
    return this.typePaths.get(typeName);
  }

  has(typeName: string): boolean {
    return this.types.has(typeName);
  }

  list(filter?: {
    origin?: "static" | "dynamic";
    tags?: string[];
  }): NodeTypeConfig[] {
    let result = Array.from(this.types.values());

    if (filter?.origin) {
      result = result.filter((t) => (t.origin ?? "static") === filter.origin);
    }
    const tags = filter?.tags;
    if (tags?.length) {
      result = result.filter((t) =>
        tags.some((tag) => t.tags.includes(tag)),
      );
    }

    return result;
  }

  scanDirectory(nodesDir: string): NodeTypeConfig[] {
    const registered: NodeTypeConfig[] = [];

    if (!fs.existsSync(nodesDir)) return registered;

    const entries = fs.readdirSync(nodesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue; // skip _dynamic etc.

      const dirPath = path.join(nodesDir, entry.name);
      const configPath = path.join(dirPath, "config.json");
      if (!fs.existsSync(configPath)) continue;

      try {
        registered.push(this.register(dirPath));
      } catch (err) {
        // Surface schema-discipline failures loudly — they're almost
        // always actionable (config.json missing inputSchema).
        logger.error(
          { dirPath, error: err instanceof Error ? err.message : String(err) },
          "Failed to register node type",
        );
      }
    }

    return registered;
  }

  /**
   * Scan `node_modules/@brain/node-*` and register each package whose
   * `config.json` validates. Mirrors `scanDirectory()` for nodes shipped
   * as npm packages instead of in-tree workspaces — the install path
   * for the upcoming domain-split (brAIn-perception, brAIn-memory, …).
   *
   * Resolution: each matched directory under `@brain/` is treated as
   * the node root. The package's `dist/handler.js` (referenced by
   * `package.json:main`) is what `BrainService.loadHandler` will
   * dynamically import — same contract as in-tree nodes.
   */
  scanInstalledPackages(nodeModulesDir: string): NodeTypeConfig[] {
    const registered: NodeTypeConfig[] = [];
    const scopeDir = path.join(nodeModulesDir, "@brain");
    if (!fs.existsSync(scopeDir)) return registered;

    const entries = fs.readdirSync(scopeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("node-")) continue;

      const dirPath = path.join(scopeDir, entry.name);
      const configPath = path.join(dirPath, "config.json");
      if (!fs.existsSync(configPath)) continue;

      try {
        registered.push(this.register(dirPath));
      } catch {
        logger.warn({ dirPath }, "Failed to register installed node type");
      }
    }

    return registered;
  }
}
