"""SQLite-backed speaker profile store.

Each profile holds a name, a color, and a centroid embedding (Float32 blob).
The identity layer reads/updates centroids; the API layer reads/renames them.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

PALETTE = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#a855f7",
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
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                color        TEXT NOT NULL,
                centroid     BLOB,
                sample_count INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
            """
        )
        self._conn.commit()

    def list(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, name, color, sample_count, created_at, updated_at FROM profiles ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]

    def get(self, profile_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT id, name, color, sample_count, created_at, updated_at FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
        return dict(row) if row else None

    def get_centroid(self, profile_id: str) -> np.ndarray | None:
        row = self._conn.execute(
            "SELECT centroid FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if row is None or row["centroid"] is None:
            return None
        return np.frombuffer(row["centroid"], dtype=np.float32).copy()

    def all_centroids(self) -> list[tuple[str, np.ndarray]]:
        rows = self._conn.execute(
            "SELECT id, centroid FROM profiles WHERE centroid IS NOT NULL"
        ).fetchall()
        return [(r["id"], np.frombuffer(r["centroid"], dtype=np.float32).copy()) for r in rows]

    def create(
        self,
        name: str | None = None,
        color: str | None = None,
        centroid: np.ndarray | None = None,
    ) -> dict[str, Any]:
        idx = self._conn.execute("SELECT COUNT(*) AS n FROM profiles").fetchone()["n"]
        profile_id = f"sp_{uuid4().hex[:8]}"
        resolved_name = name or f"Speaker {idx + 1}"
        resolved_color = color or _pick_color(idx)
        now = _now()
        blob = centroid.astype(np.float32).tobytes() if centroid is not None else None
        sample_count = 1 if centroid is not None else 0
        self._conn.execute(
            "INSERT INTO profiles (id, name, color, centroid, sample_count, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (profile_id, resolved_name, resolved_color, blob, sample_count, now, now),
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

    def update_centroid(self, profile_id: str, centroid: np.ndarray) -> None:
        blob = centroid.astype(np.float32).tobytes()
        self._conn.execute(
            "UPDATE profiles SET centroid = ?, sample_count = sample_count + 1, updated_at = ?"
            " WHERE id = ?",
            (blob, _now(), profile_id),
        )
        self._conn.commit()

    def delete(self, profile_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def merge(self, source_id: str, target_id: str) -> dict[str, Any] | None:
        src = self.get_centroid(source_id)
        tgt = self.get_centroid(target_id)
        if src is not None and tgt is not None:
            merged = (src + tgt) / 2.0
            norm = np.linalg.norm(merged)
            if norm > 0:
                merged = merged / norm
            self.update_centroid(target_id, merged.astype(np.float32))
        self.delete(source_id)
        return self.get(target_id)

    def close(self) -> None:
        self._conn.close()
