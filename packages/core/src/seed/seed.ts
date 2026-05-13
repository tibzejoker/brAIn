import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import type { NodeInstanceConfig, MailboxConfig } from "@brain/sdk";
import { logger } from "../logger";

interface SeedSubscription {
  topic: string;
  /** Required when overriding subscriptions in a seed. */
  description?: string;
  inputSchema?: Record<string, unknown>;
  min_criticality?: number;
  mailbox?: Partial<MailboxConfig>;
}

interface SeedNode {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  subscriptions?: SeedSubscription[];
  priority?: number;
  authority_level?: number;
  transport?: "process" | "container";
  position?: { x: number; y: number };
  config_overrides?: Record<string, unknown>;
}

/**
 * A type the seed depends on. The framework checks the type registry
 * before spawning; if missing, it asks the StoreService to install
 * `package_name` from the marketplace. `package_name` defaults to
 * `@brain/node-<type>` so most seeds can omit it.
 */
export interface SeedNeed {
  type: string;
  package_name?: string;
}

interface SeedConfig {
  needs?: SeedNeed[];
  nodes: SeedNode[];
}

/** Result shape returned by loadSeedFile — needs surface alongside the node configs. */
export interface LoadedSeed {
  needs: SeedNeed[];
  nodes: NodeInstanceConfig[];
}

export interface ValidationError {
  line?: number;
  message: string;
}

export interface SeedInfo {
  name: string;
  filename: string;
  path: string;
  valid: boolean;
  errors: ValidationError[];
  node_count: number;
  nodes: Array<{ type: string; name: string }>;
  /** `brAIn-<area>` when the seed is shipped by a store under
   *  `storeprojects/<store>/seeds/`, otherwise `null` for root seeds. */
  store: string | null;
  /** Unique node types this seed needs to spawn. Derived from
   *  `unique(nodes[].type)` — no separate `needs[]` declaration. */
  required_types: string[];
  /** Subset of `required_types` not currently registered. The seed
   *  stays `valid` (YAML is well-formed); the dashboard uses this to
   *  red-flag missing types and disable the Apply button. */
  missing_types: string[];
  /** For every type referenced by this seed, the store-repo it ships
   *  from (e.g. `brAIn-essentials`), or null when we couldn't locate
   *  it under any storeprojects/<store>/nodes/<type>/ folder.
   *  Computed dynamically — no per-seed declaration. Powers the
   *  "part of project X" tooltip in the dashboard. */
  type_sources: Record<string, string | null>;
}

/**
 * Scan every `storeprojects/<store>/nodes/<type>/` and return a map
 * from node-type-name → owning store name. Used to answer
 * "which project does type X come from?" for both installed and
 * missing types — as long as the providing store is cloned locally,
 * we can attribute the type, whether or not it's currently loaded
 * into the type registry.
 */
export function buildTypeStoreMap(storeprojectsRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(storeprojectsRoot)) return out;
  for (const store of fs.readdirSync(storeprojectsRoot, { withFileTypes: true })) {
    if (!store.isDirectory()) continue;
    if (!/^brAIn-/i.test(store.name)) continue;
    const nodesDir = path.join(storeprojectsRoot, store.name, "nodes");
    if (!fs.existsSync(nodesDir)) continue;
    for (const typeDir of fs.readdirSync(nodesDir, { withFileTypes: true })) {
      if (!typeDir.isDirectory()) continue;
      // First store to claim a type wins. Types are globally unique by
      // convention so a collision would already be a registration bug.
      if (!out.has(typeDir.name)) out.set(typeDir.name, store.name);
    }
  }
  return out;
}

function validateSeedContent(raw: string, knownTypes?: Set<string>): {
  valid: boolean;
  errors: ValidationError[];
  config: SeedConfig | null;
} {
  const errors: ValidationError[] = [];

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const yamlErr = err as { mark?: { line?: number }; message?: string };
    errors.push({
      line: yamlErr.mark?.line !== undefined ? yamlErr.mark.line + 1 : undefined,
      message: `YAML parse error: ${yamlErr.message ?? String(err)}`,
    });
    return { valid: false, errors, config: null };
  }

  if (typeof parsed !== "object" || parsed === null) {
    errors.push({ message: "Seed file must be a YAML object" });
    return { valid: false, errors, config: null };
  }

  if (!("nodes" in parsed)) {
    errors.push({ message: "Missing required 'nodes' key" });
    return { valid: false, errors, config: null };
  }

  const nodesRaw = (parsed as Record<string, unknown>).nodes;
  if (!Array.isArray(nodesRaw)) {
    errors.push({ message: "'nodes' must be an array" });
    return { valid: false, errors, config: null };
  }

  const config = parsed as SeedConfig;

  // Optional `needs[]` block — types this seed requires to be
  // installed before it can spawn anything. Each entry needs a `type`
  // string; `package_name` defaults to `@brain/node-<type>` at install
  // time, so seeds can omit it for the standard naming convention.
  if (config.needs !== undefined) {
    if (!Array.isArray(config.needs)) {
      errors.push({ message: "'needs' must be an array" });
    } else {
      for (let i = 0; i < config.needs.length; i++) {
        const n = config.needs[i];
        if (!n.type || typeof n.type !== "string") {
          errors.push({ message: `needs[${i}]: missing or invalid 'type'` });
        }
        if (n.package_name !== undefined && typeof n.package_name !== "string") {
          errors.push({ message: `needs[${i}]: 'package_name' must be a string` });
        }
      }
    }
  }

  const names = new Set<string>();

  // Unknown node types are NOT a validation error — the seed YAML can
  // be perfectly well-formed while still referencing types the local
  // registry doesn't have yet. The scanner surfaces those as
  // `missing_types` so the dashboard can grey out the Apply button
  // without hiding the seed entirely. `needs[]` (legacy) is still
  // parsed for back-compat but no longer drives validation; required
  // types are derived from `nodes[].type` instead.

  for (let i = 0; i < config.nodes.length; i++) {
    const node = config.nodes[i];
    const prefix = `nodes[${i}]`;

    if (!node.type || typeof node.type !== "string") {
      errors.push({ message: `${prefix}: missing or invalid 'type'` });
    }

    if (!node.name || typeof node.name !== "string") {
      errors.push({ message: `${prefix}: missing or invalid 'name'` });
    } else if (names.has(node.name)) {
      errors.push({ message: `${prefix}: duplicate name '${node.name}'` });
    } else {
      names.add(node.name);
    }

    if (node.priority !== undefined && (typeof node.priority !== "number" || node.priority < 0)) {
      errors.push({ message: `${prefix}: 'priority' must be a positive number` });
    }

    if (node.authority_level !== undefined && ![0, 1, 2].includes(node.authority_level)) {
      errors.push({ message: `${prefix}: 'authority_level' must be 0, 1, or 2` });
    }

    if (node.transport !== undefined && !["process", "container"].includes(node.transport)) {
      errors.push({ message: `${prefix}: 'transport' must be 'process' or 'container'` });
    }

    if (node.subscriptions) {
      if (!Array.isArray(node.subscriptions)) {
        errors.push({ message: `${prefix}: 'subscriptions' must be an array` });
      } else {
        for (let j = 0; j < node.subscriptions.length; j++) {
          const sub = node.subscriptions[j];
          if (!sub.topic || typeof sub.topic !== "string") {
            errors.push({ message: `${prefix}.subscriptions[${j}]: missing or invalid 'topic'` });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, config };
}

export function loadSeedFile(filePath: string): LoadedSeed {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const { valid, errors, config } = validateSeedContent(raw);

  if (!valid || !config) {
    throw new Error(`Invalid seed file: ${errors.map((e) => e.message).join("; ")}`);
  }

  logger.info(
    { file: filePath, needs_count: config.needs?.length ?? 0, nodes_count: config.nodes.length },
    "Loaded seed file",
  );

  const nodes = config.nodes.map((node): NodeInstanceConfig => ({
    type: node.type,
    name: node.name,
    description: node.description,
    tags: node.tags,
    subscriptions: node.subscriptions?.map((s) => ({
      topic: s.topic,
      // Seeds without an explicit description fall back to the topic
      // name — the type's default_subscriptions still carry the real
      // description, so this only loses metadata when the seed
      // overrides a subscription that didn't exist on the type.
      description: s.description ?? s.topic,
      ...(s.inputSchema ? { inputSchema: s.inputSchema } : {}),
      ...(s.min_criticality !== undefined ? { min_criticality: s.min_criticality } : {}),
      ...(s.mailbox ? { mailbox: s.mailbox } : {}),
    })),
    priority: node.priority,
    authority_level: node.authority_level,
    transport: node.transport,
    position: node.position,
    config_overrides: node.config_overrides,
  }));

  return { needs: config.needs ?? [], nodes };
}

export interface ScanOptions {
  knownTypes?: Set<string>;
  /** Store-of-origin tagged onto every seed found in this directory. */
  store?: string | null;
  /** Map type-name → owning store, used to fill SeedInfo.type_sources. */
  typeStoreMap?: Map<string, string>;
}

export function scanSeedsDirectory(seedsDir: string, opts: ScanOptions = {}): SeedInfo[] {
  if (!fs.existsSync(seedsDir)) return [];

  const { knownTypes, store = null, typeStoreMap } = opts;
  const entries = fs.readdirSync(seedsDir, { withFileTypes: true });
  const seeds: SeedInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;

    const filePath = path.join(seedsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const name = entry.name.replace(/\.(yaml|yml)$/, "");

    const { valid, errors, config } = validateSeedContent(raw, knownTypes);

    // Required types are derived from the actual spawn list — no
    // separate `needs[]` declaration. Missing types are surfaced as a
    // capability gap, not a validation error (the YAML is well-formed).
    const usedTypes = new Set((config?.nodes ?? []).map((n) => n.type).filter((t): t is string => typeof t === "string"));
    const required_types = [...usedTypes].sort();
    const missing_types = knownTypes
      ? required_types.filter((t) => !knownTypes.has(t))
      : [];
    const type_sources: Record<string, string | null> = {};
    for (const t of required_types) {
      type_sources[t] = typeStoreMap?.get(t) ?? null;
    }

    seeds.push({
      name,
      filename: entry.name,
      path: filePath,
      valid,
      errors,
      node_count: config?.nodes.length ?? 0,
      nodes: config?.nodes.map((n) => ({ type: n.type, name: n.name })) ?? [],
      store,
      required_types,
      missing_types,
      type_sources,
    });
  }

  return seeds;
}

/**
 * Walk every `storeprojects/<store>/seeds/` and merge with the root
 * `seedsDir`. Each store's seeds are tagged with their owning store
 * so the dashboard can group / badge them. Types referenced by any
 * seed are attributed to their source store via `buildTypeStoreMap`.
 */
export function scanAllSeedSources(
  rootSeedsDir: string,
  storeprojectsRoot: string,
  knownTypes?: Set<string>,
): SeedInfo[] {
  const typeStoreMap = buildTypeStoreMap(storeprojectsRoot);
  const out: SeedInfo[] = scanSeedsDirectory(rootSeedsDir, { knownTypes, store: null, typeStoreMap });
  if (fs.existsSync(storeprojectsRoot)) {
    for (const store of fs.readdirSync(storeprojectsRoot, { withFileTypes: true })) {
      if (!store.isDirectory()) continue;
      if (!/^brAIn-/i.test(store.name)) continue;
      const seedsDir = path.join(storeprojectsRoot, store.name, "seeds");
      out.push(...scanSeedsDirectory(seedsDir, { knownTypes, store: store.name, typeStoreMap }));
    }
  }
  return out;
}
