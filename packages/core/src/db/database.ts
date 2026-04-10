import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../logger";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS node_instances (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    authority_level INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 1,
    transport TEXT NOT NULL DEFAULT 'process',
    config_overrides TEXT NOT NULL DEFAULT '{}',
    position_x REAL NOT NULL DEFAULT 0,
    position_y REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    min_criticality INTEGER,
    mailbox_max_size INTEGER NOT NULL DEFAULT 100,
    mailbox_retention TEXT NOT NULL DEFAULT 'latest',
    FOREIGN KEY (node_id) REFERENCES node_instances(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_node ON subscriptions(node_id);

  CREATE TABLE IF NOT EXISTS network_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    action TEXT NOT NULL,
    node_id TEXT,
    node_name TEXT,
    node_type TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    snapshot TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_history_timestamp ON network_history(timestamp);
  CREATE INDEX IF NOT EXISTS idx_history_action ON network_history(action);
  CREATE INDEX IF NOT EXISTS idx_history_node ON network_history(node_id);
`;

let db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? path.resolve(process.cwd(), "data", "brain.db");
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  logger.info({ path: resolvedPath }, "Database initialized");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface SavedNode {
  id: string;
  type: string;
  name: string;
  tags: string;
  authority_level: number;
  priority: number;
  transport: string;
  config_overrides: string;
  position_x: number;
  position_y: number;
  created_at: number;
}

export interface SavedSubscription {
  id: number;
  node_id: string;
  topic: string;
  min_criticality: number | null;
  mailbox_max_size: number;
  mailbox_retention: string;
}

export function saveNode(
  db: Database.Database,
  node: SavedNode,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO node_instances (id, type, name, tags, authority_level, priority, transport, config_overrides, position_x, position_y, created_at)
    VALUES (@id, @type, @name, @tags, @authority_level, @priority, @transport, @config_overrides, @position_x, @position_y, @created_at)
  `).run(node);
}

export function saveSubscription(
  db: Database.Database,
  sub: Omit<SavedSubscription, "id">,
): void {
  db.prepare(`
    INSERT INTO subscriptions (node_id, topic, min_criticality, mailbox_max_size, mailbox_retention)
    VALUES (@node_id, @topic, @min_criticality, @mailbox_max_size, @mailbox_retention)
  `).run(sub);
}

export function updateNodePosition(
  db: Database.Database,
  nodeId: string,
  x: number,
  y: number,
): void {
  db.prepare("UPDATE node_instances SET position_x = ?, position_y = ? WHERE id = ?").run(x, y, nodeId);
}

export function deleteNode(db: Database.Database, nodeId: string): void {
  db.prepare("DELETE FROM node_instances WHERE id = ?").run(nodeId);
}

export function loadAllNodes(db: Database.Database): SavedNode[] {
  return db.prepare("SELECT * FROM node_instances").all() as SavedNode[];
}

export function loadSubscriptions(db: Database.Database, nodeId: string): SavedSubscription[] {
  return db.prepare("SELECT * FROM subscriptions WHERE node_id = ?").all(nodeId) as SavedSubscription[];
}

export function clearAll(db: Database.Database): void {
  db.exec("DELETE FROM subscriptions; DELETE FROM node_instances;");
}

// === History ===

export type HistoryAction =
  | "node.spawned"
  | "node.killed"
  | "node.stopped"
  | "node.started"
  | "node.woken"
  | "node.rewired"
  | "network.seeded"
  | "network.reset";

export interface HistoryEntry {
  id: number;
  timestamp: number;
  action: HistoryAction;
  node_id: string | null;
  node_name: string | null;
  node_type: string | null;
  details: string;
  snapshot: string | null;
}

export function recordHistory(
  db: Database.Database,
  entry: {
    action: HistoryAction;
    node_id?: string;
    node_name?: string;
    node_type?: string;
    details?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO network_history (timestamp, action, node_id, node_name, node_type, details, snapshot)
    VALUES (@timestamp, @action, @node_id, @node_name, @node_type, @details, @snapshot)
  `).run({
    timestamp: Date.now(),
    action: entry.action,
    node_id: entry.node_id ?? null,
    node_name: entry.node_name ?? null,
    node_type: entry.node_type ?? null,
    details: JSON.stringify(entry.details ?? {}),
    snapshot: entry.snapshot ? JSON.stringify(entry.snapshot) : null,
  });
}

export function getHistory(
  db: Database.Database,
  opts?: {
    last?: number;
    action?: HistoryAction;
    node_id?: string;
    since?: number;
  },
): HistoryEntry[] {
  let query = "SELECT * FROM network_history WHERE 1=1";
  const params: Record<string, unknown> = {};

  if (opts?.action) {
    query += " AND action = @action";
    params.action = opts.action;
  }
  if (opts?.node_id) {
    query += " AND node_id = @node_id";
    params.node_id = opts.node_id;
  }
  if (opts?.since) {
    query += " AND timestamp >= @since";
    params.since = opts.since;
  }

  query += " ORDER BY timestamp DESC";

  const limit = opts?.last ?? 50;
  query += " LIMIT @limit";
  params.limit = limit;

  return db.prepare(query).all(params) as HistoryEntry[];
}
