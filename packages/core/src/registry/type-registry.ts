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
    const config = JSON.parse(raw) as NodeTypeConfig;

    if (!config.name) {
      throw new Error(`config.json at ${dirPath} is missing "name" field`);
    }

    this.types.set(config.name, config);
    this.typePaths.set(config.name, dirPath);
    return config;
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
      } catch {
        logger.warn({ dirPath }, "Failed to register node type");
      }
    }

    return registered;
  }
}
