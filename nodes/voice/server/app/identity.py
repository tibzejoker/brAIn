"""Persistent speaker identity layer.

Sortformer assigns ephemeral spk_0..3 labels per chunk. We turn those into
stable speaker IDs by:
  1. Computing a WeSpeaker embedding for each "long enough" segment.
  2. Cosine-matching it against stored profile centroids.
  3. Either updating the matched centroid (EMA) or creating a new profile.

This module is intentionally engine-agnostic: feed it (audio_pcm, sr) +
metadata, it returns a resolved speaker_id.
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
        if self._embedder is None:
            return self._resolve_by_label(diar_label)

        if segment_pcm is None:
            return self._resolve_by_label(diar_label)

        duration_ms = (len(segment_pcm) / sample_rate) * 1000
        if duration_ms < settings.min_segment_ms:
            return None

        embedding = self._embedder.embed(segment_pcm, sample_rate)
        embedding = _l2_normalize(embedding)
        emb_norm = float(np.linalg.norm(embedding))

        candidates = self._store.all_centroids()
        if not candidates:
            profile = self._store.create(centroid=embedding)
            log.info("identity: first profile created %s (norm=%.3f)", profile["id"], emb_norm)
            return IdentityResult(profile["id"], profile["name"], 1.0, True, False)

        sims: list[tuple[str, float]] = []
        for pid, centroid in candidates:
            sim = float(np.dot(embedding, centroid))
            sims.append((pid, sim))
        sims.sort(key=lambda x: x[1], reverse=True)
        best_id, best_sim = sims[0]
        sims_str = ", ".join(f"{pid[:12]}={sim:+.3f}" for pid, sim in sims[:5])
        log.info(
            "identity: emb_norm=%.3f thresholds(match=%.2f uncertain=%.2f) sims=[%s]",
            emb_norm, settings.match_threshold, settings.uncertain_threshold, sims_str,
        )

        if best_sim >= settings.match_threshold:
            updated = _ema_update(
                self._store.get_centroid(best_id), embedding, settings.ema_decay
            )
            self._store.update_centroid(best_id, updated)
            profile = self._store.get(best_id)
            assert profile is not None
            log.info("identity: MATCH → %s (%s) sim=%.3f", profile["id"], profile["name"], best_sim)
            return IdentityResult(profile["id"], profile["name"], best_sim, False, False)

        if best_sim >= settings.uncertain_threshold:
            profile = self._store.get(best_id)
            assert profile is not None
            log.info("identity: UNCERTAIN → %s (%s) sim=%.3f", profile["id"], profile["name"], best_sim)
            return IdentityResult(profile["id"], profile["name"], best_sim, False, True)

        profile = self._store.create(centroid=embedding)
        log.info("identity: NEW profile %s (best_sim=%.3f below uncertain=%.2f)",
                 profile["id"], best_sim, settings.uncertain_threshold)
        return IdentityResult(profile["id"], profile["name"], 1.0, True, False)

    def _resolve_by_label(self, diar_label: str) -> IdentityResult:
        """Used when no embedder is available: map ephemeral diar labels to
        stable profile IDs for the lifetime of the resolver. Good enough for
        UI validation until Phase 3 plugs in a real embedder."""
        existing_id = self._label_to_profile.get(diar_label)
        if existing_id is not None:
            profile = self._store.get(existing_id)
            if profile is not None:
                return IdentityResult(
                    speaker_id=profile["id"],
                    name=profile["name"],
                    confidence=1.0,
                    is_new=False,
                    provisional=True,
                )

        profile = self._store.create()
        self._label_to_profile[diar_label] = profile["id"]
        return IdentityResult(
            speaker_id=profile["id"],
            name=profile["name"],
            confidence=1.0,
            is_new=True,
            provisional=True,
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
    """Interface — concrete impl will load WeSpeaker ONNX in Phase 3."""

    def embed(self, pcm: np.ndarray, sample_rate: int) -> np.ndarray:  # noqa: ARG002
        raise NotImplementedError("Embedder not implemented yet (Phase 3)")
