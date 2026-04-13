import * as fs from "fs";
import * as path from "path";
import type { NodeHandler, TextPayload } from "@brain/sdk";

interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  created_by: string;
}

type MemoryStore = Record<string, MemoryEntry>;

function resolveStorePath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const dataDir = path.join(dir, "data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      return path.join(dataDir, "memory.json");
    }
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), "data", "memory.json");
}

function loadStore(filePath: string): MemoryStore {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as MemoryStore;
  } catch {
    return {};
  }
}

function saveStore(filePath: string, store: MemoryStore): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

interface Request {
  action: string;
  key?: string;
  value?: string;
  tags?: string[];
  query?: string;
}

function parseRequest(content: string): Request | null {
  try {
    return JSON.parse(content) as Request;
  } catch {
    return null;
  }
}

export const handler: NodeHandler = (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return Promise.resolve();
  }

  const storePath = resolveStorePath();
  const store = loadStore(storePath);
  let changed = false;

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const action = msg.topic.split(".").pop() ?? "";
    const req = parseRequest(payload.content);

    let result: Record<string, unknown>;

    switch (action) {
      case "store": {
        if (!req || !req.key || !req.value) {
          result = { error: "store requires key and value", example: '{"key":"name","value":"Thibaut","tags":["user"]}' };
          break;
        }
        const prev = store[req.key] as MemoryEntry | undefined;
        store[req.key] = {
          key: req.key,
          value: req.value,
          tags: req.tags ?? [],
          created_at: prev?.created_at ?? Date.now(),
          updated_at: Date.now(),
          created_by: msg.from,
        };
        changed = true;
        ctx.log("info", `Stored: ${req.key} = ${req.value.slice(0, 80)}`);
        result = { ok: true, key: req.key, action: "stored" };
        break;
      }

      case "recall": {
        if (!req || !req.key) {
          result = { error: "recall requires key", example: '{"key":"name"}' };
          break;
        }
        const entry = store[req.key] as MemoryEntry | undefined;
        if (entry) {
          result = { found: true, ...entry };
        } else {
          result = { found: false, key: req.key };
        }
        break;
      }

      case "search": {
        const query = req?.query ?? payload.content;
        const q = query.toLowerCase();
        const matches = Object.values(store).filter((e) =>
          e.key.toLowerCase().includes(q) ||
          e.value.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)),
        );
        result = { count: matches.length, results: matches };
        break;
      }

      case "update": {
        if (!req || !req.key) {
          result = { error: "update requires key", example: '{"key":"name","value":"new value","tags":["new"]}' };
          break;
        }
        const existing = store[req.key] as MemoryEntry | undefined;
        if (!existing) {
          result = { error: `Key not found: ${req.key}` };
          break;
        }
        if (req.value) existing.value = req.value;
        if (req.tags) existing.tags = req.tags;
        existing.updated_at = Date.now();
        changed = true;
        ctx.log("info", `Updated: ${req.key}`);
        result = { ok: true, key: req.key, action: "updated" };
        break;
      }

      case "delete": {
        if (!req || !req.key) {
          result = { error: "delete requires key", example: '{"key":"name"}' };
          break;
        }
        const toDelete = store[req.key] as MemoryEntry | undefined;
        if (toDelete) {
          delete store[req.key];
          changed = true;
          ctx.log("info", `Deleted: ${req.key}`);
          result = { ok: true, key: req.key, action: "deleted", was: toDelete.value.slice(0, 100) };
        } else {
          result = { error: `Key not found: ${req.key}` };
        }
        break;
      }

      case "list": {
        const tag = req?.query ?? req?.tags?.[0];
        let entries = Object.values(store);
        if (tag) {
          entries = entries.filter((e) => e.tags.includes(tag));
        }
        result = {
          count: entries.length,
          entries: entries.map((e) => ({ key: e.key, value: e.value.slice(0, 100), tags: e.tags, updated_at: e.updated_at })),
        };
        break;
      }

      default:
        result = { error: `Unknown action: ${action}`, available: ["store", "recall", "search", "update", "delete", "list"] };
    }

    ctx.publish("memory.result", {
      type: "text",
      criticality: 1,
      payload: { content: JSON.stringify(result) },
      metadata: { action, requested_by: msg.from },
    });
  }

  if (changed) {
    saveStore(storePath, store);
  }

  return Promise.resolve();
};
