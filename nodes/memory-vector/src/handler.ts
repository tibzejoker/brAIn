import * as fs from "fs";
import * as path from "path";
import * as lancedb from "@lancedb/lancedb";
import type { NodeHandler, TextPayload } from "@brain/sdk";

interface StoreRequest {
  text: string;
  tags?: string[];
  source?: string;
}

interface SearchRequest {
  query: string;
  limit?: number;
}

interface IndexRequest {
  directory: string;
  extensions?: string[];
}

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b";

function resolveDbPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const dataDir = path.join(dir, "data", "vector_db");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      return dataDir;
    }
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), "data", "vector_db");
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.statusText}`);
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

async function getOrCreateTable(
  dbPath: string,
): Promise<{ db: lancedb.Connection; table: lancedb.Table | null }> {
  const db = await lancedb.connect(dbPath);
  try {
    const table = await db.openTable("memories");
    return { db, table };
  } catch {
    return { db, table: null };
  }
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) return;

  const dbPath = resolveDbPath();

  for (const msg of ctx.messages) {
    const action = msg.topic.split(".").pop() ?? "";
    const payload = msg.payload as TextPayload;
    let result: Record<string, unknown>;

    try {
      switch (action) {
        case "store": {
          const req = JSON.parse(payload.content) as StoreRequest;
          if (!req.text) { result = { error: "store requires text" }; break; }

          ctx.log("info", `Embedding: "${req.text.slice(0, 60)}..."`);
          const vector = await embed(req.text);

          const { db, table } = await getOrCreateTable(dbPath);
          const doc = {
            id: Date.now(),
            text: req.text,
            tags: (req.tags ?? []).join(","),
            source: req.source ?? msg.from,
            created_at: Date.now(),
            vector,
          };

          if (table) {
            await table.add([doc]);
          } else {
            await db.createTable("memories", [doc]);
          }

          ctx.log("info", `Stored in vector DB (${vector.length}d)`);
          result = { ok: true, action: "stored", dimensions: vector.length };
          break;
        }

        case "search": {
          const req = JSON.parse(payload.content) as SearchRequest;
          if (!req.query) { result = { error: "search requires query" }; break; }

          ctx.log("info", `Searching: "${req.query.slice(0, 60)}"`);
          const queryVector = await embed(req.query);
          const { table } = await getOrCreateTable(dbPath);

          if (!table) {
            result = { results: [], count: 0, note: "Vector DB is empty. Store something first." };
            break;
          }

          const limit = req.limit ?? 5;
          const results = await table.vectorSearch(queryVector).limit(limit).toArray();

          result = {
            count: results.length,
            results: results.map((r: Record<string, unknown>) => ({
              text: r.text,
              tags: r.tags,
              source: r.source,
              distance: r._distance,
            })),
          };
          ctx.log("info", `Found ${results.length} results`);
          break;
        }

        case "index": {
          const req = JSON.parse(payload.content) as IndexRequest;
          if (!req.directory) { result = { error: "index requires directory" }; break; }

          const exts = req.extensions ?? [".ts", ".js", ".md", ".txt"];
          ctx.log("info", `Indexing ${req.directory} (${exts.join(",")})`);

          const files = findFiles(req.directory, exts);
          ctx.log("info", `Found ${files.length} files`);

          const { db, table } = await getOrCreateTable(dbPath);
          let indexed = 0;
          const docs: Array<Record<string, unknown>> = [];

          for (const file of files) {
            const content = fs.readFileSync(file, "utf-8");
            const chunks = chunkText(content, 15);

            for (const chunk of chunks) {
              if (chunk.trim().length < 50) continue;
              try {
                const vector = await embed(chunk);
                docs.push({
                  id: Date.now() + indexed,
                  text: chunk,
                  tags: path.extname(file),
                  source: path.relative(req.directory, file),
                  created_at: Date.now(),
                  vector,
                });
                indexed++;
                if (indexed % 10 === 0) ctx.log("debug", `Indexed ${indexed} chunks...`);
              } catch {
                ctx.log("warn", `Failed to embed chunk from ${file}`);
              }
            }
          }

          if (docs.length > 0) {
            if (table) {
              await table.add(docs);
            } else {
              await db.createTable("memories", docs);
            }
          }

          ctx.log("info", `Indexed ${indexed} chunks from ${files.length} files`);
          result = { ok: true, files: files.length, chunks: indexed };
          break;
        }

        default:
          result = { error: `Unknown action: ${action}`, available: ["store", "search", "index"] };
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
      ctx.log("error", `Error: ${result.error as string}`);
    }

    ctx.respond(JSON.stringify(result), { action, requested_by: msg.from });
  }
};

function findFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  const excludes = new Set(["node_modules", ".git", "dist", "build", ".next"]);

  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || excludes.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) results.push(full);
    }
  }

  walk(dir);
  return results;
}

function chunkText(text: string, linesPerChunk: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const chunks: string[] = [];
  const overlap = 3;

  for (let i = 0; i < lines.length; i += linesPerChunk - overlap) {
    const chunk = lines.slice(i, i + linesPerChunk).join("\n");
    if (chunk.length >= 50) chunks.push(chunk);
  }

  return chunks;
}
