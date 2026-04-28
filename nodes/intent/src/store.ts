/**
 * SQLite-backed store for the intent node.
 *
 * Two tables:
 *   - persons: canonical identity that links a voice_profile_id ↔
 *     gaze_profile_id ↔ display name. Linking is dynamic — the user
 *     creates a person via the UI and binds existing voice/gaze
 *     profiles to it.
 *   - intents: append-only log of correlated speech-target intents
 *     produced by the correlator.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const FALLBACK_COLORS = ["#a855f7", "#06b6d4", "#22c55e", "#f59e0b", "#ec4899", "#3b82f6", "#ef4444", "#84cc16"];
function pickColor(): string {
  return FALLBACK_COLORS[Math.floor(Math.random() * FALLBACK_COLORS.length)];
}

export interface Person {
  id: string;
  name: string;
  color: string;
  voice_profile_id: string | null;
  gaze_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntentRecord {
  id: number;
  ts: string;
  source_person_id: string | null;
  source_voice_profile_id: string | null;
  source_name: string | null;
  target_kind: string;
  target_person_id: string | null;
  target_gaze_profile_id: string | null;
  target_name: string | null;
  text: string;
  t_start: number;
  t_end: number;
  confidence: number;
}

export class IntentStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        voice_profile_id TEXT,
        gaze_profile_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_persons_voice ON persons(voice_profile_id);
      CREATE INDEX IF NOT EXISTS idx_persons_gaze ON persons(gaze_profile_id);

      CREATE TABLE IF NOT EXISTS intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        source_person_id TEXT,
        source_voice_profile_id TEXT,
        source_name TEXT,
        target_kind TEXT NOT NULL,
        target_person_id TEXT,
        target_gaze_profile_id TEXT,
        target_name TEXT,
        text TEXT NOT NULL,
        t_start REAL NOT NULL,
        t_end REAL NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intents_ts ON intents(ts);
    `);
  }

  close(): void {
    this.db.close();
  }

  listPersons(): Person[] {
    return this.db.prepare("SELECT * FROM persons ORDER BY created_at").all() as Person[];
  }

  getPerson(id: string): Person | null {
    return (this.db.prepare("SELECT * FROM persons WHERE id = ?").get(id) as Person | undefined) ?? null;
  }

  findByVoice(voicePid: string): Person | null {
    return (this.db.prepare("SELECT * FROM persons WHERE voice_profile_id = ?").get(voicePid) as Person | undefined) ?? null;
  }

  findByGaze(gazePid: string): Person | null {
    return (this.db.prepare("SELECT * FROM persons WHERE gaze_profile_id = ?").get(gazePid) as Person | undefined) ?? null;
  }

  createPerson(input: { name: string; color?: string; voice_profile_id?: string | null; gaze_profile_id?: string | null }): Person {
    const id = `p_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();
    const color = input.color ?? pickColor();
    this.db.prepare(`
      INSERT INTO persons (id, name, color, voice_profile_id, gaze_profile_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, color, input.voice_profile_id ?? null, input.gaze_profile_id ?? null, now, now);
    const p = this.getPerson(id);
    if (!p) throw new Error("createPerson: insert succeeded but row missing");
    return p;
  }

  patchPerson(id: string, patch: Partial<Pick<Person, "name" | "color" | "voice_profile_id" | "gaze_profile_id">>): Person | null {
    const cur = this.getPerson(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.db.prepare(`
      UPDATE persons SET name=?, color=?, voice_profile_id=?, gaze_profile_id=?, updated_at=?
      WHERE id=?
    `).run(merged.name, merged.color, merged.voice_profile_id, merged.gaze_profile_id, merged.updated_at, id);
    return this.getPerson(id);
  }

  deletePerson(id: string): boolean {
    const res = this.db.prepare("DELETE FROM persons WHERE id = ?").run(id);
    return res.changes > 0;
  }

  recordIntent(rec: Omit<IntentRecord, "id" | "ts"> & { ts?: string }): IntentRecord {
    const ts = rec.ts ?? new Date().toISOString();
    const res = this.db.prepare(`
      INSERT INTO intents (ts, source_person_id, source_voice_profile_id, source_name,
                           target_kind, target_person_id, target_gaze_profile_id, target_name,
                           text, t_start, t_end, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts, rec.source_person_id, rec.source_voice_profile_id, rec.source_name,
      rec.target_kind, rec.target_person_id, rec.target_gaze_profile_id, rec.target_name,
      rec.text, rec.t_start, rec.t_end, rec.confidence,
    );
    return { id: Number(res.lastInsertRowid), ts, ...rec };
  }

  listIntents(opts: { limit?: number; since_id?: number } = {}): IntentRecord[] {
    const limit = opts.limit ?? 100;
    if (opts.since_id !== undefined) {
      return this.db.prepare("SELECT * FROM intents WHERE id > ? ORDER BY id DESC LIMIT ?").all(opts.since_id, limit) as IntentRecord[];
    }
    return this.db.prepare("SELECT * FROM intents ORDER BY id DESC LIMIT ?").all(limit) as IntentRecord[];
  }

  clearIntents(): number {
    return this.db.prepare("DELETE FROM intents").run().changes;
  }
}
