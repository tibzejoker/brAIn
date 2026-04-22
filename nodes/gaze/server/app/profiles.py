"""SQLite-backed face profile store with multiple faceprints per profile.

Mirrors voice/server/app/profiles.py but for face embeddings (512d from
InsightFace buffalo_l). A profile is a logical identity (name, color) owning
1+ faceprints — each faceprint is one distinct appearance centroid (different
angle, lighting, expression). Matching scans every faceprint across every
profile and the best one wins.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

# Warm palette to visually distinguish from voice's cool palette.
PALETTE = [
    "#f59e0b", "#ef4444", "#ec4899", "#a855f7", "#8b5cf6",
    "#06b6d4", "#10b981", "#84cc16", "#eab308", "#f97316",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pick_color(idx: int) -> str:
    return PALETTE[idx % len(PALETTE)]


class ProfileStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                color        TEXT NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);

            CREATE TABLE IF NOT EXISTS faceprints (
                id           TEXT PRIMARY KEY,
                profile_id   TEXT NOT NULL,
                centroid     BLOB NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 1,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_faceprints_profile ON faceprints(profile_id);

            CREATE TABLE IF NOT EXISTS gaze_events (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                ts                 TEXT NOT NULL,
                source_profile_id  TEXT,
                target_type        TEXT NOT NULL,  -- 'profile' | 'camera' | 'scene'
                target_profile_id  TEXT,
                description        TEXT,
                gaze_x             REAL,
                gaze_y             REAL,
                FOREIGN KEY (source_profile_id) REFERENCES profiles(id) ON DELETE SET NULL,
                FOREIGN KEY (target_profile_id) REFERENCES profiles(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON gaze_events(ts);
            CREATE INDEX IF NOT EXISTS idx_events_source ON gaze_events(source_profile_id);
            """
        )
        self._conn.commit()

    # ---------------------- profiles ---------------------- #

    def list(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT
                p.id, p.name, p.color, p.sample_count, p.created_at, p.updated_at,
                COUNT(f.id) AS faceprint_count
            FROM profiles p
            LEFT JOIN faceprints f ON f.profile_id = p.id
            GROUP BY p.id
            ORDER BY p.created_at
            """
        ).fetchall()
        return [dict(r) for r in rows]

    def get(self, profile_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT
                p.id, p.name, p.color, p.sample_count, p.created_at, p.updated_at,
                COUNT(f.id) AS faceprint_count
            FROM profiles p
            LEFT JOIN faceprints f ON f.profile_id = p.id
            WHERE p.id = ?
            GROUP BY p.id
            """,
            (profile_id,),
        ).fetchone()
        return dict(row) if row else None

    def create(
        self,
        name: str | None = None,
        color: str | None = None,
        centroid: np.ndarray | None = None,
    ) -> dict[str, Any]:
        idx = self._conn.execute("SELECT COUNT(*) AS n FROM profiles").fetchone()["n"]
        profile_id = f"face_{uuid4().hex[:8]}"
        resolved_name = name or f"Face {idx + 1}"
        resolved_color = color or _pick_color(idx)
        now = _now()
        self._conn.execute(
            "INSERT INTO profiles (id, name, color, sample_count, created_at, updated_at)"
            " VALUES (?, ?, ?, 0, ?, ?)",
            (profile_id, resolved_name, resolved_color, now, now),
        )
        if centroid is not None:
            self._add_faceprint(profile_id, centroid)
            self._conn.execute(
                "UPDATE profiles SET sample_count = 1 WHERE id = ?", (profile_id,)
            )
        self._conn.commit()
        result = self.get(profile_id)
        assert result is not None
        return result

    def patch(self, profile_id: str, name: str | None, color: str | None) -> dict[str, Any] | None:
        if name is None and color is None:
            return self.get(profile_id)
        fields, values = [], []
        if name is not None:
            fields.append("name = ?")
            values.append(name)
        if color is not None:
            fields.append("color = ?")
            values.append(color)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(profile_id)
        self._conn.execute(f"UPDATE profiles SET {', '.join(fields)} WHERE id = ?", values)
        self._conn.commit()
        return self.get(profile_id)

    def delete(self, profile_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def merge(self, source_id: str, target_id: str) -> dict[str, Any] | None:
        if source_id == target_id:
            return self.get(target_id)
        if self.get(target_id) is None:
            return None
        source = self.get(source_id)
        if source is None:
            return self.get(target_id)
        self._conn.execute(
            "UPDATE faceprints SET profile_id = ?, updated_at = ? WHERE profile_id = ?",
            (target_id, _now(), source_id),
        )
        # Re-parent historical events so they survive the merge.
        self._conn.execute(
            "UPDATE gaze_events SET source_profile_id = ? WHERE source_profile_id = ?",
            (target_id, source_id),
        )
        self._conn.execute(
            "UPDATE gaze_events SET target_profile_id = ? WHERE target_profile_id = ?",
            (target_id, source_id),
        )
        self._conn.execute(
            "UPDATE profiles SET sample_count = sample_count + ?, updated_at = ? WHERE id = ?",
            (source["sample_count"], _now(), target_id),
        )
        self._conn.execute("DELETE FROM profiles WHERE id = ?", (source_id,))
        self._conn.commit()
        return self.get(target_id)

    def bump_sample(self, profile_id: str) -> None:
        self._conn.execute(
            "UPDATE profiles SET sample_count = sample_count + 1, updated_at = ? WHERE id = ?",
            (_now(), profile_id),
        )
        self._conn.commit()

    # ---------------------- faceprints ---------------------- #

    def all_faceprints(self) -> list[tuple[str, str, np.ndarray]]:
        rows = self._conn.execute(
            "SELECT id, profile_id, centroid FROM faceprints"
        ).fetchall()
        return [
            (r["id"], r["profile_id"],
             np.frombuffer(r["centroid"], dtype=np.float32).copy())
            for r in rows
        ]

    def faceprints_for(self, profile_id: str) -> list[tuple[str, np.ndarray]]:
        rows = self._conn.execute(
            "SELECT id, centroid FROM faceprints WHERE profile_id = ?", (profile_id,)
        ).fetchall()
        return [
            (r["id"], np.frombuffer(r["centroid"], dtype=np.float32).copy())
            for r in rows
        ]

    def faceprints_meta_for(self, profile_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, sample_count, created_at, updated_at FROM faceprints"
            " WHERE profile_id = ? ORDER BY created_at",
            (profile_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def extract_faceprint(self, faceprint_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT profile_id FROM faceprints WHERE id = ?", (faceprint_id,)
        ).fetchone()
        if row is None:
            return None
        new_profile = self.create()
        self._conn.execute(
            "UPDATE faceprints SET profile_id = ?, updated_at = ? WHERE id = ?",
            (new_profile["id"], _now(), faceprint_id),
        )
        self._conn.commit()
        return self.get(new_profile["id"])

    def update_faceprint(self, faceprint_id: str, centroid: np.ndarray) -> None:
        blob = centroid.astype(np.float32).tobytes()
        self._conn.execute(
            "UPDATE faceprints SET centroid = ?, sample_count = sample_count + 1,"
            " updated_at = ? WHERE id = ?",
            (blob, _now(), faceprint_id),
        )
        self._conn.commit()

    def add_faceprint(self, profile_id: str, centroid: np.ndarray) -> str:
        return self._add_faceprint(profile_id, centroid, commit=True)

    def _add_faceprint(
        self, profile_id: str, centroid: np.ndarray, commit: bool = False,
    ) -> str:
        fp_id = f"fp_{uuid4().hex[:8]}"
        now = _now()
        self._conn.execute(
            "INSERT INTO faceprints (id, profile_id, centroid, sample_count, created_at, updated_at)"
            " VALUES (?, ?, ?, 1, ?, ?)",
            (fp_id, profile_id, centroid.astype(np.float32).tobytes(), now, now),
        )
        if commit:
            self._conn.commit()
        return fp_id

    def delete_faceprint(self, faceprint_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM faceprints WHERE id = ?", (faceprint_id,))
        self._conn.commit()
        return cur.rowcount > 0

    # ---------------------- events ---------------------- #

    def record_event(
        self,
        source_profile_id: str | None,
        target_type: str,
        target_profile_id: str | None = None,
        description: str | None = None,
        gaze_xy: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        now = _now()
        cur = self._conn.execute(
            "INSERT INTO gaze_events "
            "(ts, source_profile_id, target_type, target_profile_id, description, gaze_x, gaze_y)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                now, source_profile_id, target_type, target_profile_id, description,
                gaze_xy[0] if gaze_xy else None,
                gaze_xy[1] if gaze_xy else None,
            ),
        )
        self._conn.commit()
        event_id = cur.lastrowid
        return {
            "id": event_id,
            "ts": now,
            "source_profile_id": source_profile_id,
            "target_type": target_type,
            "target_profile_id": target_profile_id,
            "description": description,
            "gaze_x": gaze_xy[0] if gaze_xy else None,
            "gaze_y": gaze_xy[1] if gaze_xy else None,
        }

    def list_events(self, limit: int = 200, since_id: int | None = None) -> list[dict[str, Any]]:
        if since_id is None:
            rows = self._conn.execute(
                "SELECT id, ts, source_profile_id, target_type, target_profile_id,"
                " description, gaze_x, gaze_y FROM gaze_events"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in reversed(rows)]
        rows = self._conn.execute(
            "SELECT id, ts, source_profile_id, target_type, target_profile_id,"
            " description, gaze_x, gaze_y FROM gaze_events"
            " WHERE id > ? ORDER BY id ASC LIMIT ?",
            (since_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def clear_events(self) -> int:
        cur = self._conn.execute("DELETE FROM gaze_events")
        self._conn.commit()
        return cur.rowcount

    def close(self) -> None:
        self._conn.close()
