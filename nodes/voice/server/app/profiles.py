"""SQLite-backed speaker profile store with multiple voiceprints per profile.

A profile is a logical identity (name, color). It owns 1+ voiceprints — each
is a distinct embedding centroid representing one "vocal mode" (normal voice,
shouting, whispered, etc). Matching scans all voiceprints across all profiles
and the best-matching voiceprint determines which profile is chosen.

This lets a profile cover several distinct vocal modes without diluting any
of them via averaging.
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
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()
        self._migrate_legacy_centroids()

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

            CREATE TABLE IF NOT EXISTS voiceprints (
                id           TEXT PRIMARY KEY,
                profile_id   TEXT NOT NULL,
                centroid     BLOB NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 1,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_voiceprints_profile ON voiceprints(profile_id);
            """
        )
        self._conn.commit()

    def _migrate_legacy_centroids(self) -> None:
        rows = self._conn.execute(
            "SELECT id, centroid, sample_count FROM profiles WHERE centroid IS NOT NULL"
        ).fetchall()
        for row in rows:
            existing = self._conn.execute(
                "SELECT 1 FROM voiceprints WHERE profile_id = ? LIMIT 1", (row["id"],)
            ).fetchone()
            if existing is not None:
                continue
            now = _now()
            self._conn.execute(
                "INSERT INTO voiceprints (id, profile_id, centroid, sample_count, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    f"vp_{uuid4().hex[:8]}", row["id"], row["centroid"],
                    max(1, int(row["sample_count"])), now, now,
                ),
            )
        self._conn.commit()

    # ---------------------- profiles ---------------------- #

    def list(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT
                p.id, p.name, p.color, p.created_at, p.updated_at,
                COALESCE(SUM(v.sample_count), 0) AS sample_count,
                COUNT(v.id) AS voiceprint_count
            FROM profiles p
            LEFT JOIN voiceprints v ON v.profile_id = p.id
            GROUP BY p.id
            ORDER BY p.created_at
            """
        ).fetchall()
        return [dict(r) for r in rows]

    def get(self, profile_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT
                p.id, p.name, p.color, p.created_at, p.updated_at,
                COALESCE(SUM(v.sample_count), 0) AS sample_count,
                COUNT(v.id) AS voiceprint_count
            FROM profiles p
            LEFT JOIN voiceprints v ON v.profile_id = p.id
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
        profile_id = f"sp_{uuid4().hex[:8]}"
        resolved_name = name or f"Speaker {idx + 1}"
        resolved_color = color or _pick_color(idx)
        now = _now()
        self._conn.execute(
            "INSERT INTO profiles (id, name, color, sample_count, created_at, updated_at)"
            " VALUES (?, ?, ?, 0, ?, ?)",
            (profile_id, resolved_name, resolved_color, now, now),
        )
        if centroid is not None:
            self._add_voiceprint(profile_id, centroid)
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
        """Re-parent all voiceprints from source to target, then delete source.

        Voiceprints keep their distinct centroids — no averaging — so the
        target ends up covering every vocal mode the source had recorded.
        """
        if source_id == target_id:
            return self.get(target_id)
        if self.get(target_id) is None:
            return None
        self._conn.execute(
            "UPDATE voiceprints SET profile_id = ?, updated_at = ? WHERE profile_id = ?",
            (target_id, _now(), source_id),
        )
        self._conn.execute("DELETE FROM profiles WHERE id = ?", (source_id,))
        self._conn.commit()
        return self.get(target_id)

    # ---------------------- voiceprints ---------------------- #

    def all_voiceprints(self) -> list[tuple[str, str, np.ndarray]]:
        """Returns (voiceprint_id, profile_id, centroid) for every voiceprint."""
        rows = self._conn.execute(
            "SELECT id, profile_id, centroid FROM voiceprints"
        ).fetchall()
        return [
            (r["id"], r["profile_id"],
             np.frombuffer(r["centroid"], dtype=np.float32).copy())
            for r in rows
        ]

    def voiceprints_for(self, profile_id: str) -> list[tuple[str, np.ndarray]]:
        rows = self._conn.execute(
            "SELECT id, centroid FROM voiceprints WHERE profile_id = ?", (profile_id,)
        ).fetchall()
        return [
            (r["id"], np.frombuffer(r["centroid"], dtype=np.float32).copy())
            for r in rows
        ]

    def voiceprints_meta_for(self, profile_id: str) -> list[dict[str, Any]]:
        """Voiceprints without the centroid blob — for UI listing."""
        rows = self._conn.execute(
            "SELECT id, sample_count, created_at, updated_at FROM voiceprints"
            " WHERE profile_id = ? ORDER BY created_at",
            (profile_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def extract_voiceprint(self, voiceprint_id: str) -> dict[str, Any] | None:
        """Move a voiceprint to a brand-new profile. Returns the new profile.

        If the source profile would be left with zero voiceprints, the source
        profile is preserved (not deleted) — extraction is non-destructive.
        """
        row = self._conn.execute(
            "SELECT profile_id FROM voiceprints WHERE id = ?", (voiceprint_id,)
        ).fetchone()
        if row is None:
            return None
        new_profile = self.create()
        self._conn.execute(
            "UPDATE voiceprints SET profile_id = ?, updated_at = ? WHERE id = ?",
            (new_profile["id"], _now(), voiceprint_id),
        )
        self._conn.commit()
        return self.get(new_profile["id"])

    def update_voiceprint(self, voiceprint_id: str, centroid: np.ndarray) -> None:
        blob = centroid.astype(np.float32).tobytes()
        self._conn.execute(
            "UPDATE voiceprints SET centroid = ?, sample_count = sample_count + 1,"
            " updated_at = ? WHERE id = ?",
            (blob, _now(), voiceprint_id),
        )
        self._conn.commit()

    def add_voiceprint(self, profile_id: str, centroid: np.ndarray) -> str:
        return self._add_voiceprint(profile_id, centroid, commit=True)

    def _add_voiceprint(
        self, profile_id: str, centroid: np.ndarray, commit: bool = False,
    ) -> str:
        vp_id = f"vp_{uuid4().hex[:8]}"
        now = _now()
        self._conn.execute(
            "INSERT INTO voiceprints (id, profile_id, centroid, sample_count, created_at, updated_at)"
            " VALUES (?, ?, ?, 1, ?, ?)",
            (vp_id, profile_id, centroid.astype(np.float32).tobytes(), now, now),
        )
        if commit:
            self._conn.commit()
        return vp_id

    def delete_voiceprint(self, voiceprint_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM voiceprints WHERE id = ?", (voiceprint_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self._conn.close()
