export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown>;
}

const DEFAULT_MAX = 200;

export class NodeLog {
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX) {
    this.maxEntries = maxEntries;
  }

  add(level: LogEntry["level"], message: string, data?: Record<string, unknown>): void {
    this.entries.push({ timestamp: Date.now(), level, message, data });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.add("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.add("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.add("error", message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.add("debug", message, data);
  }

  getAll(): LogEntry[] {
    return [...this.entries];
  }

  getLast(n: number): LogEntry[] {
    return this.entries.slice(-n);
  }

  get size(): number {
    return this.entries.length;
  }
}
