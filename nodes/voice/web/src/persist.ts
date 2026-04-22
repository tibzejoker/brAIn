/**
 * LocalStorage persistence for the timeline + transcript.
 *
 * Keyed by session id so different sessions don't collide. Cleared explicitly
 * via clearSession() — survives page refresh / restart otherwise.
 */
import type { SegmentEvent } from "./types";

const KEY_PREFIX = "voice-session:";

export type StoredSession = {
  segments: SegmentEvent[];
  startedAt: number;     // unix ms — virtual epoch for the timeline
};

export function loadSession(sessionId: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + sessionId);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredSession;
    if (!Array.isArray(data.segments)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveSession(sessionId: string, session: StoredSession): void {
  try {
    localStorage.setItem(KEY_PREFIX + sessionId, JSON.stringify(session));
  } catch {
    /* quota or disabled — ignore */
  }
}

export function clearSession(sessionId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    /* ignore */
  }
}
