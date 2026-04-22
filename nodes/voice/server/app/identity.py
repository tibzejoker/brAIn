"""Persistent speaker identity layer.

Each profile owns 1+ voiceprints (centroids). Matching scans every voiceprint
across every profile and the best one wins — its parent profile is the result.

This lets a single profile cover several distinct vocal modes (normal voice,
shouting, whispered) without averaging them into a useless mean centroid.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from .config import settings
from .profiles import ProfileStore

log = logging.getLogger(__name__)


@dataclass(slots=True)
class IdentityResult:
    speaker_id: str
    name: str
    confidence: float
    is_new: bool
    provisional: bool


class IdentityResolver:
    def __init__(self, store: ProfileStore, embedder: "Embedder | None" = None) -> None:
        self._store = store
        self._embedder = embedder
        self._label_to_profile: dict[str, str] = {}

    def set_embedder(self, embedder: "Embedder") -> None:
        self._embedder = embedder

    def reset_label_map(self) -> None:
        self._label_to_profile.clear()

    def resolve(
        self,
        segment_pcm: np.ndarray | None,
        sample_rate: int,
        diar_label: str,
    ) -> IdentityResult | None:
        if self._embedder is None or segment_pcm is None:
            return self._resolve_by_label(diar_label)

        duration_ms = (len(segment_pcm) / sample_rate) * 1000
        if duration_ms < settings.min_segment_ms:
            return None

        embedding = self._embedder.embed(segment_pcm, sample_rate)
        embedding = _l2_normalize(embedding)

        voiceprints = self._store.all_voiceprints()
        if not voiceprints:
            profile = self._store.create(centroid=embedding)
            log.info("identity: first profile created %s", profile["id"])
            return IdentityResult(profile["id"], profile["name"], 1.0, True, False)

        # Best voiceprint across all profiles wins.
        best_vp_id, best_pid, best_sim = "", "", -1.0
        # For logging: best per profile.
        per_profile_best: dict[str, float] = {}
        for vp_id, pid, centroid in voiceprints:
            sim = float(np.dot(embedding, centroid))
            if sim > per_profile_best.get(pid, -1.0):
                per_profile_best[pid] = sim
            if sim > best_sim:
                best_vp_id, best_pid, best_sim = vp_id, pid, sim

        sims_str = ", ".join(
            f"{pid[:12]}={sim:+.3f}"
            for pid, sim in sorted(per_profile_best.items(), key=lambda x: -x[1])[:5]
        )
        log.info(
            "identity: thresholds(match=%.2f uncertain=%.2f) per-profile=[%s]",
            settings.match_threshold, settings.uncertain_threshold, sims_str,
        )

        if best_sim >= settings.match_threshold:
            prev = self._store.voiceprints_for(best_pid)
            prev_centroid = next((c for vid, c in prev if vid == best_vp_id), None)
            updated = _ema_update(prev_centroid, embedding, settings.ema_decay)
            self._store.update_voiceprint(best_vp_id, updated)
            profile = self._store.get(best_pid)
            assert profile is not None
            log.info("identity: MATCH → %s (%s) sim=%.3f vp=%s",
                     profile["id"], profile["name"], best_sim, best_vp_id)
            return IdentityResult(profile["id"], profile["name"], best_sim, False, False)

        if best_sim >= settings.uncertain_threshold:
            profile = self._store.get(best_pid)
            assert profile is not None
            log.info("identity: UNCERTAIN → %s (%s) sim=%.3f", profile["id"], profile["name"], best_sim)
            return IdentityResult(profile["id"], profile["name"], best_sim, False, True)

        profile = self._store.create(centroid=embedding)
        log.info("identity: NEW profile %s (best_sim=%.3f below uncertain=%.2f)",
                 profile["id"], best_sim, settings.uncertain_threshold)
        return IdentityResult(profile["id"], profile["name"], 1.0, True, False)

    def _resolve_by_label(self, diar_label: str) -> IdentityResult:
        existing_id = self._label_to_profile.get(diar_label)
        if existing_id is not None:
            profile = self._store.get(existing_id)
            if profile is not None:
                return IdentityResult(
                    speaker_id=profile["id"], name=profile["name"],
                    confidence=1.0, is_new=False, provisional=True,
                )
        profile = self._store.create()
        self._label_to_profile[diar_label] = profile["id"]
        return IdentityResult(
            speaker_id=profile["id"], name=profile["name"],
            confidence=1.0, is_new=True, provisional=True,
        )


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return v if norm == 0 else (v / norm).astype(np.float32)


def _ema_update(prev: np.ndarray | None, new: np.ndarray, decay: float) -> np.ndarray:
    if prev is None:
        return new
    merged = (1.0 - decay) * prev + decay * new
    return _l2_normalize(merged)


class Embedder:
    def embed(self, pcm: np.ndarray, sample_rate: int) -> np.ndarray:  # noqa: ARG002
        raise NotImplementedError("Embedder not implemented yet (Phase 3)")
