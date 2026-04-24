"""SQLite-backed store of linked persons.

Each person is the intent-node-level identity: a canonical name + color +
optional link to a voice-profile id and/or a gaze-profile id. The upstream
servers stay authoritative about voice and face identities — this table
only carries the mapping.
"""
from __future__ import annotations

import datetime as dt
import sqlite3
import uuid
from pathlib import Path

# Warm palette, disjoint from voice (cool blues) and gaze (warm ambers) so
# the UI makes it obvious which panel you're looking at.
_COLORS = [
    "#a855f7", "#ec4899", "#14b8a6", "#f97316",
    "#eab308", "#10b981", "#0ea5e9", "#ef4444",
    "#8b5cf6", "#06b6d4",
]


def _now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


class PersonStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._init()

    def _init(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS persons (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                voice_profile_id TEXT UNIQUE,
                gaze_profile_id TEXT UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

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
            """
        )
        self._conn.commit()

    def _next_color(self) -> str:
        n = self._conn.execute("SELECT COUNT(*) FROM persons").fetchone()[0]
        return _COLORS[n % len(_COLORS)]

    def list(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, name, color, voice_profile_id, gaze_profile_id, "
            "created_at, updated_at FROM persons ORDER BY created_at"
        ).fetchall()
        return [self._row_to_person(r) for r in rows]

    def get(self, person_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT id, name, color, voice_profile_id, gaze_profile_id, "
            "created_at, updated_at FROM persons WHERE id=?",
            (person_id,),
        ).fetchone()
        return self._row_to_person(row) if row else None

    def find_by_voice(self, voice_profile_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT id, name, color, voice_profile_id, gaze_profile_id, "
            "created_at, updated_at FROM persons WHERE voice_profile_id=?",
            (voice_profile_id,),
        ).fetchone()
        return self._row_to_person(row) if row else None

    def find_by_gaze(self, gaze_profile_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT id, name, color, voice_profile_id, gaze_profile_id, "
            "created_at, updated_at FROM persons WHERE gaze_profile_id=?",
            (gaze_profile_id,),
        ).fetchone()
        return self._row_to_person(row) if row else None

    def _steal_link(self, voice_profile_id: str | None, gaze_profile_id: str | None,
                    exclude_person_id: str | None = None) -> None:
        """Detach a voice / gaze profile from whatever person currently owns
        it. Called before linking the profile somewhere else, so the UNIQUE
        constraint doesn't blow up and the user sees a clean reassignment."""
        now = _now_iso()
        if voice_profile_id:
            self._conn.execute(
                "UPDATE persons SET voice_profile_id = NULL, updated_at = ? "
                "WHERE voice_profile_id = ? AND id != COALESCE(?, '')",
                (now, voice_profile_id, exclude_person_id or ""),
            )
        if gaze_profile_id:
            self._conn.execute(
                "UPDATE persons SET gaze_profile_id = NULL, updated_at = ? "
                "WHERE gaze_profile_id = ? AND id != COALESCE(?, '')",
                (now, gaze_profile_id, exclude_person_id or ""),
            )

    def create(
        self,
        name: str,
        color: str | None = None,
        voice_profile_id: str | None = None,
        gaze_profile_id: str | None = None,
    ) -> dict:
        self._steal_link(voice_profile_id, gaze_profile_id)
        pid = f"person_{uuid.uuid4().hex[:8]}"
        now = _now_iso()
        self._conn.execute(
            "INSERT INTO persons (id, name, color, voice_profile_id, gaze_profile_id, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (pid, name, color or self._next_color(), voice_profile_id, gaze_profile_id, now, now),
        )
        self._conn.commit()
        person = self.get(pid)
        assert person is not None
        return person

    def patch(
        self,
        person_id: str,
        name: str | None,
        color: str | None,
        voice_profile_id: str | None,
        gaze_profile_id: str | None,
    ) -> dict | None:
        current = self.get(person_id)
        if current is None:
            return None
        # Re-home any profile that's currently linked somewhere else before
        # we try to link it here. Empty string = explicit unlink, so skip.
        steal_voice = voice_profile_id if voice_profile_id else None
        steal_gaze = gaze_profile_id if gaze_profile_id else None
        self._steal_link(steal_voice, steal_gaze, exclude_person_id=person_id)
        fields: list[tuple[str, str | None]] = []
        if name is not None:
            fields.append(("name", name))
        if color is not None:
            fields.append(("color", color))
        if voice_profile_id is not None:
            # Empty string = unlink (set NULL).
            fields.append(("voice_profile_id", voice_profile_id or None))
        if gaze_profile_id is not None:
            fields.append(("gaze_profile_id", gaze_profile_id or None))
        if not fields:
            return current
        fields.append(("updated_at", _now_iso()))
        set_clause = ", ".join(f"{k}=?" for k, _ in fields)
        values = [v for _, v in fields] + [person_id]
        self._conn.execute(f"UPDATE persons SET {set_clause} WHERE id=?", values)
        self._conn.commit()
        return self.get(person_id)

    def delete(self, person_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM persons WHERE id=?", (person_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def record_intent(
        self,
        source_person_id: str | None,
        source_voice_profile_id: str | None,
        source_name: str | None,
        target_kind: str,
        target_person_id: str | None,
        target_gaze_profile_id: str | None,
        target_name: str | None,
        text: str,
        t_start: float,
        t_end: float,
        confidence: float,
    ) -> int:
        cur = self._conn.execute(
            "INSERT INTO intents (ts, source_person_id, source_voice_profile_id, "
            "source_name, target_kind, target_person_id, target_gaze_profile_id, "
            "target_name, text, t_start, t_end, confidence) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                _now_iso(), source_person_id, source_voice_profile_id, source_name,
                target_kind, target_person_id, target_gaze_profile_id, target_name,
                text, t_start, t_end, confidence,
            ),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def list_intents(self, limit: int = 200, since_id: int | None = None) -> list[dict]:
        sql = (
            "SELECT id, ts, source_person_id, source_voice_profile_id, source_name, "
            "target_kind, target_person_id, target_gaze_profile_id, target_name, "
            "text, t_start, t_end, confidence FROM intents"
        )
        args: list = []
        if since_id is not None:
            sql += " WHERE id>?"
            args.append(since_id)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        rows = self._conn.execute(sql, args).fetchall()
        return [
            {
                "id": r[0], "ts": r[1], "source_person_id": r[2],
                "source_voice_profile_id": r[3], "source_name": r[4],
                "target_kind": r[5], "target_person_id": r[6],
                "target_gaze_profile_id": r[7], "target_name": r[8],
                "text": r[9], "t_start": r[10], "t_end": r[11], "confidence": r[12],
            }
            for r in rows
        ]

    def clear_intents(self) -> int:
        cur = self._conn.execute("DELETE FROM intents")
        self._conn.commit()
        return cur.rowcount

    def close(self) -> None:
        self._conn.close()

    @staticmethod
    def _row_to_person(row: tuple) -> dict:
        return {
            "id": row[0], "name": row[1], "color": row[2],
            "voice_profile_id": row[3], "gaze_profile_id": row[4],
            "created_at": row[5], "updated_at": row[6],
        }
