/**
 * Skill store: the network's procedural-memory library, read from disk.
 *
 * A skill is a directory `<root>/<name>/SKILL.md` with YAML frontmatter
 * (`name`, `description`) + a markdown body, per the open Agent Skills
 * standard (agentskills.io). Sources, in override order (later wins):
 *   1. a root `skills/` dir (BRAIN_SKILLS_DIR),
 *   2. every installed library's `storeprojects/<repo>/skills/`,
 *   3. personal / distilled skills under `data/skills/`.
 *
 * Exposed to the whole network over NATS request/reply (see BrainService),
 * so any node — local or on a remote brain-agent — gets a skill served on
 * demand without storing anything locally. Retrieval is a cheap keyword
 * overlap for now; swapping in memory-vector embeddings is a drop-in (the
 * `search` signature doesn't change).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface SkillMeta {
  name: string;
  description: string;
  /** Content hash. A bump tells consumer caches to refetch. */
  version: string;
  /** Where it came from ("root" | "<repo>" | "personal"), for provenance. */
  source: string;
  /** Node-scoped skill: only relevant when an instance of this node TYPE is
   *  spawned. Set via frontmatter `requires_node: <type>`. Absent = a
   *  user/capability skill (always available once installed). */
  requiresNode?: string;
}

export interface SkillFull extends SkillMeta {
  /** The full SKILL.md text (frontmatter + body), ready to inject. */
  content: string;
}

interface Parsed extends SkillFull {
  dir: string;
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const m = /^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function hashVersion(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function scanDir(dir: string, source: string, into: Map<string, Parsed>): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    const fm = parseFrontmatter(content);
    // The DIRECTORY name is the canonical identity (per the Agent Skills
    // spec: frontmatter `name` must match the dir). Keying on the dir keeps
    // load / delete path-resolvable even if the frontmatter name drifts.
    const name = entry.name;
    into.set(name, {
      name,
      description: fm.description || "",
      version: hashVersion(content),
      source,
      requiresNode: fm.requires_node || undefined,
      content,
      dir: path.join(dir, entry.name),
    });
  }
}

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// --- Semantic retrieval (embeddings) ---------------------------------------
// Mirrors brAIn-memory/memory-vector: embed via Ollama's /api/embed. Keyword
// overlap is blind cross-language (a French question vs an English skill
// description scores 0); embeddings match on meaning instead. Self-contained
// here (no memory-vector node needed) with a keyword fallback when Ollama is
// unreachable or the embed model isn't pulled.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b";
/** Skill embeddings keyed by content version — survives across the
 *  per-call SkillStore instances, so we embed each skill once. */
const embedCache = new Map<string, number[]>();

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const v = data.embeddings?.[0];
  if (!v?.length) throw new Error("embed: empty vector");
  return v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface SkillRoots {
  /** Root `skills/` dir (optional). */
  skillsDir?: string;
  /** `storeprojects/` root; every `<repo>/skills/` under it is scanned. */
  storeprojectsRoot?: string;
  /** Personal / distilled skills dir (e.g. `data/skills`). */
  personalDir?: string;
}

/** Filesystem-backed skill library. Re-reads on each call (cheap at this
 *  scale); a watch + in-memory index is a later optimisation. */
export class SkillStore {
  constructor(private readonly roots: SkillRoots) {}

  private scan(): Parsed[] {
    const byName = new Map<string, Parsed>();
    if (this.roots.skillsDir) scanDir(this.roots.skillsDir, "root", byName);
    const sp = this.roots.storeprojectsRoot;
    if (sp && fs.existsSync(sp)) {
      for (const repo of fs.readdirSync(sp, { withFileTypes: true })) {
        if (!repo.isDirectory() || !/^brAIn-/i.test(repo.name)) continue;
        scanDir(path.join(sp, repo.name, "skills"), repo.name, byName);
      }
    }
    if (this.roots.personalDir) scanDir(this.roots.personalDir, "personal", byName);
    return [...byName.values()];
  }

  private meta(s: Parsed): SkillMeta {
    return { name: s.name, description: s.description, version: s.version, source: s.source, requiresNode: s.requiresNode };
  }

  /** Drop node-scoped skills whose node type isn't currently spawned. When
   *  `liveTypes` is undefined (e.g. the dashboard browsing), nothing is
   *  filtered — every skill is shown. */
  private applicable(skills: Parsed[], liveTypes?: Set<string>): Parsed[] {
    if (!liveTypes) return skills;
    return skills.filter((s) => !s.requiresNode || liveTypes.has(s.requiresNode));
  }

  /** Tier-1: ranked name + description by keyword overlap with the query.
   *  `liveTypes` (the currently-spawned node types) filters node-scoped skills. */
  search(query: string, limit = 5, liveTypes?: Set<string>): SkillMeta[] {
    const q = new Set(tokens(query));
    if (q.size === 0) return [];
    return this.applicable(this.scan(), liveTypes)
      .map((s) => {
        const hay = new Set(tokens(`${s.name} ${s.description}`));
        let score = 0;
        for (const t of q) if (hay.has(t)) score++;
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.description.length - b.s.description.length)
      .slice(0, limit)
      .map(({ s }) => this.meta(s));
  }

  /** Semantic search: rank by embedding similarity (handles cross-language
   *  and synonyms). Falls back to keyword {@link search} when Ollama is
   *  unreachable or nothing embeds. `liveTypes` filters node-scoped skills. */
  async searchSemantic(query: string, limit = 5, liveTypes?: Set<string>): Promise<SkillMeta[]> {
    const skills = this.applicable(this.scan(), liveTypes);
    if (skills.length === 0 || !query.trim()) return [];
    let qv: number[];
    try {
      qv = await embed(query);
    } catch {
      return this.search(query, limit, liveTypes); // Ollama down → keyword
    }
    const scored: Array<{ s: Parsed; score: number }> = [];
    for (const s of skills) {
      let v = embedCache.get(s.version);
      if (!v) {
        try { v = await embed(`${s.name}\n${s.description}`); embedCache.set(s.version, v); }
        catch { continue; }
      }
      scored.push({ s, score: cosine(qv, v) });
    }
    if (scored.length === 0) return this.search(query, limit, liveTypes);
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ s }) => this.meta(s));
  }

  /** Tier-2: the full SKILL.md body for one skill. */
  load(name: string): SkillFull | null {
    const s = this.scan().find((x) => x.name === name);
    return s ? { name: s.name, description: s.description, version: s.version, source: s.source, requiresNode: s.requiresNode, content: s.content } : null;
  }

  /** The whole catalog (tier-1). `liveTypes` filters node-scoped skills. */
  list(liveTypes?: Set<string>): SkillMeta[] {
    return this.applicable(this.scan(), liveTypes).map((s) => this.meta(s));
  }

  /** True when a skill is user-owned (lives in the personal dir) and so may
   *  be edited / deleted. Bundled + root skills are read-only. */
  isPersonal(name: string): boolean {
    return this.scan().find((x) => x.name === name)?.source === "personal";
  }

  /** Create or overwrite a personal skill. Writes `<personalDir>/<name>/SKILL.md`.
   *  Throws if no personal dir is configured or the name isn't kebab-safe. */
  savePersonal(name: string, content: string): SkillFull {
    if (!this.roots.personalDir) throw new Error("no personal skills dir configured");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error("skill name must be kebab-case (lowercase alphanumeric + hyphens, <=64 chars)");
    }
    const dir = path.join(this.roots.personalDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
    const loaded = this.load(name);
    if (!loaded) throw new Error("save failed");
    return loaded;
  }

  /** Delete a personal skill. Refuses to touch bundled / root skills.
   *  Returns false when the skill doesn't exist as a personal one. */
  deletePersonal(name: string): boolean {
    if (!this.roots.personalDir) return false;
    const dir = path.join(this.roots.personalDir, name);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}
