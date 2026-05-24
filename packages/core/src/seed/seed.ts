import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import { type NodeInstanceConfig, type MailboxConfig, normaliseSubscription } from "@brain/sdk";
import { logger } from "../logger";

interface SeedSubscription {
  topic: string;
  /** Required when overriding subscriptions in a seed. */
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Opt-in MCP-style RPC: declares a typed reply on `reply_to`. */
  outputSchema?: Record<string, unknown>;
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

/** Provenance of a seed file. `personal` seeds are user-saved
 *  configurations and are the ONLY ones the API allows the user to
 *  delete (store/root seeds are owned by their repo / framework). */
export type SeedSource = "store" | "personal" | "root";

export interface SeedInfo {
  name: string;
  filename: string;
  path: string;
  valid: boolean;
  errors: ValidationError[];
  node_count: number;
  nodes: Array<{ type: string; name: string }>;
  /** Where this seed comes from (filesystem layer). */
  source: SeedSource;
  /** `brAIn-<area>` when source === "store", otherwise null. */
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

function validateSeedContent(raw: string, _knownTypes?: Set<string>): {
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
    subscriptions: node.subscriptions?.map((s) => normaliseSubscription({
      topic: s.topic,
      // Seeds without an explicit description fall back to the topic
      // name — the type's default_subscriptions still carry the real
      // description, so this only loses metadata when the seed
      // overrides a subscription that didn't exist on the type.
      description: s.description ?? s.topic,
      inputSchema: s.inputSchema,
      min_criticality: s.min_criticality,
      mailbox: s.mailbox,
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
  /** Where the seeds in this directory come from. */
  source?: SeedSource;
  /** Store-of-origin tagged onto every seed found in this directory.
   *  Only meaningful when source === "store". */
  store?: string | null;
  /** Map type-name → owning store, used to fill SeedInfo.type_sources. */
  typeStoreMap?: Map<string, string>;
}

export function scanSeedsDirectory(seedsDir: string, opts: ScanOptions = {}): SeedInfo[] {
  if (!fs.existsSync(seedsDir)) return [];

  const { knownTypes, source = "root", store = null, typeStoreMap } = opts;
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
      source,
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
  personalSeedsDir?: string,
): SeedInfo[] {
  const typeStoreMap = buildTypeStoreMap(storeprojectsRoot);
  const out: SeedInfo[] = scanSeedsDirectory(rootSeedsDir, { knownTypes, source: "root", store: null, typeStoreMap });
  if (fs.existsSync(storeprojectsRoot)) {
    for (const store of fs.readdirSync(storeprojectsRoot, { withFileTypes: true })) {
      if (!store.isDirectory()) continue;
      if (!/^brAIn-/i.test(store.name)) continue;
      const seedsDir = path.join(storeprojectsRoot, store.name, "seeds");
      out.push(...scanSeedsDirectory(seedsDir, { knownTypes, source: "store", store: store.name, typeStoreMap }));
    }
  }
  if (personalSeedsDir) {
    out.push(...scanSeedsDirectory(personalSeedsDir, { knownTypes, source: "personal", store: null, typeStoreMap }));
  }
  return out;
}

// === Personal seeds (user-saved configurations) ===============================

/** Slug a user-supplied display name into a filename-safe stem.
 *  Used so "My Cool Setup #2" maps to "my-cool-setup-2.yaml". */
export function slugifySeedName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "seed";
}

/** Subset of NodeInfo we need to round-trip a running node into a
 *  seed YAML. Defined locally so seed.ts doesn't depend on the SDK
 *  beyond NodeInstanceConfig. */
export interface SerializableNode {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  subscriptions?: Array<{
    topic?: string;
    pattern?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    min_criticality?: number;
    mailbox?: Partial<MailboxConfig>;
  }>;
  priority?: number;
  authority_level?: number;
  transport?: string;
  position?: { x: number; y: number };
  config_overrides?: Record<string, unknown>;
}

export interface SavePersonalSeedOptions {
  /** Optional human-readable comment written at the top of the YAML. */
  description?: string;
  /** When true, overwrite an existing seed with the same slug.
   *  Defaults to false — caller gets an error on collision so the
   *  dashboard can prompt the user for a different name. */
  overwrite?: boolean;
}

/**
 * Write a list of running nodes out as a personal seed YAML.
 * Throws if `<dir>/<slug>.yaml` exists and `overwrite` is false.
 */
export function savePersonalSeed(
  dir: string,
  displayName: string,
  nodes: SerializableNode[],
  opts: SavePersonalSeedOptions = {},
): { slug: string; path: string } {
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugifySeedName(displayName);
  const filePath = path.join(dir, `${slug}.yaml`);
  if (fs.existsSync(filePath) && !opts.overwrite) {
    throw new Error(`A personal seed named "${slug}" already exists`);
  }

  // Strip undefined and runtime-only fields so the YAML stays clean.
  const cleanNodes = nodes.map((n) => {
    const subs = n.subscriptions
      ?.map((s) => {
        // Stored network state uses `topic` for the literal subscribed
        // string; bus-level patterns can also live under `pattern`.
        // Always emit `topic` so the loader's SeedSubscription parser
        // accepts it without ambiguity.
        const topic = s.topic ?? s.pattern;
        if (!topic) return null;
        const out: Record<string, unknown> = { topic };
        if (s.description) out.description = s.description;
        if (s.inputSchema) out.inputSchema = s.inputSchema;
        // RPC-shaped subs (MCP-style: declare a typed reply) round-trip
        // through the seed too — otherwise re-spawning from a saved
        // network would lose the output contract that drove /mcp's
        // outputSchema field on external clients.
        if (s.outputSchema) out.outputSchema = s.outputSchema;
        if (s.min_criticality !== undefined) out.min_criticality = s.min_criticality;
        if (s.mailbox) out.mailbox = s.mailbox;
        return out;
      })
      .filter((s): s is Record<string, unknown> => s !== null);

    const out: Record<string, unknown> = { type: n.type, name: n.name };
    if (n.description) out.description = n.description;
    if (n.tags?.length) out.tags = n.tags;
    if (subs && subs.length > 0) out.subscriptions = subs;
    if (n.priority !== undefined) out.priority = n.priority;
    if (n.authority_level !== undefined) out.authority_level = n.authority_level;
    if (n.transport && n.transport !== "process") out.transport = n.transport;
    if (n.position) out.position = n.position;
    if (n.config_overrides && Object.keys(n.config_overrides).length > 0) {
      out.config_overrides = n.config_overrides;
    }
    return out;
  });

  const header = [
    `# ${displayName} — personal seed.`,
    `# Saved from the running network on ${new Date().toISOString()}.`,
    opts.description ? `# ${opts.description}` : null,
    "",
  ].filter((l) => l !== null).join("\n");

  const yaml = YAML.stringify({ nodes: cleanNodes });
  fs.writeFileSync(filePath, header + yaml, { mode: 0o600 });
  return { slug, path: filePath };
}

/**
 * Remove a personal seed from disk by its slug. Throws if the file
 * doesn't exist (caller can ignore the 404 case if it wants idempotent
 * delete). Never touches store/root seeds — the controller layer is
 * responsible for refusing such requests before reaching this fn.
 */
export function deletePersonalSeed(dir: string, slug: string): void {
  const filePath = path.join(dir, `${slug}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Personal seed "${slug}" not found`);
  }
  fs.unlinkSync(filePath);
}
