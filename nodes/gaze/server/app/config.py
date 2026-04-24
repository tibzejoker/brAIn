from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GAZE_", env_file=".env", extra="ignore")

    port: int = 8766
    db_path: Path = Path("./data/gaze.db")
    models_dir: Path = Path("./models")

    # InsightFace model pack (downloaded to ~/.insightface on first use).
    # buffalo_l: ~300 MB, SCRFD detector + ArcFace R100 recognizer (best accuracy).
    # buffalo_s: ~30 MB, lighter detector + R50 recognizer (2-3x faster, slightly less precise).
    recognizer: str = "buffalo_l"
    det_size: int = 640

    # Gaze-LLE (primary gaze model) — dedicated gaze-following model built on
    # a frozen DINOv2 backbone. Returns a heatmap + inout score.
    # Variants available through torch.hub:
    #   gazelle_dinov2_vitb14_inout  — ViT-B/14 + inout (~90 MB, recommended)
    #   gazelle_dinov2_vitl14_inout  — ViT-L/14 + inout (~300 MB, more accurate)
    gazelle_variant: str = "gazelle_dinov2_vitb14_inout"
    gazelle_device: str = "auto"

    # Moondream (optional, only used when `describe=true` on /api/detect).
    moondream_repo: str = "vikhyatk/moondream2"
    moondream_revision: str = "2025-01-09"
    moondream_device: str = "auto"
    # If the gaze point falls within this normalized distance of the eye
    # midpoint, the person is considered to be looking at the camera
    # (self-referential gaze). 0.08 ≈ 8% of image width.
    looking_at_camera_threshold: float = 0.08
    # Gaze-LLE `inout` score below this threshold → target is out-of-frame.
    # The score from the public vitb/vitl _inout checkpoints is only weakly
    # separating on tight webcam crops, so we do NOT use this as the sole
    # signal for "looking at camera" (see engine._decide_camera).
    inout_threshold: float = 0.5
    # Below this Gazelle heatmap peak, we treat the gaze target as "unknown"
    # — the model hasn't localized anything confident enough to commit.
    gaze_peak_threshold: float = 0.15

    # Ignore faces whose shorter side is less than this fraction of the image's
    # shorter side. Filters out tiny background faces (group-photo crowds,
    # crowd-scene memes) before they pollute gaze / matching / events.
    min_face_fraction: float = 0.03

    # Head-yaw magnitude fallback used ONLY when iris tracking isn't
    # available (profile face, FaceLandmarker failed). In that case we
    # can't tell whether the eyes compensate, so we require the head
    # itself to be near-frontal. 0 = frontal, ~0.5 = 3/4 turn.
    camera_asym_threshold: float = 0.25

    # MediaPipe iris tracker lives at this path. Downloaded by
    # `setup_models.py` from Google Cloud Storage; ~3.6 MB .task file.
    face_landmarker_path: Path = Path("./models/face_landmarker.task")

    # Max |world-frame gaze yaw| still considered "looking at camera".
    # world_yaw = head_yaw + iris_compensation. 0 = exactly at camera.
    # Both are expressed in half-eye-distance units. 0.30 ≈ ±15° gaze
    # off the lens — tight enough to avoid flagging "head frontal but
    # eyes reading a phone beside the camera" cases.
    camera_yaw_threshold: float = 0.30
    # Scaling between iris offset (measured along eye axis, ±0.5 extent)
    # and head yaw (half-eye-distance units). Empirical: an iris shift of
    # 0.5 along the axis ≈ a head turn of 1.0, so iris * 2 ≈ head.
    iris_to_head_scale: float = 2.0

    # Heartbeat period for persistent-state events — when a subject holds
    # the same gaze state longer than this, we re-emit the same event as
    # a keep-alive so downstream correlators (intent) never see a stale
    # "gap" that really means "state held, no transition". Keep close to
    # the intent correlator's state_freshness window (~2s).
    event_heartbeat_s: float = 1.5

    # ArcFace cosine-similarity thresholds. 0.42 is the classic safe default on
    # L2-normalized embeddings; raise for stricter matching (more new profiles).
    match_threshold: float = 0.42
    uncertain_threshold: float = 0.30
    ema_decay: float = 0.15

    # When deciding "face A looks at face B", inflate B's bbox by this fraction
    # of the image size. Tight default (2%) to reduce false positives when a
    # noisy gaze point lands on the border of another face.
    looking_at_margin: float = 0.02
    # Minimum Euclidean distance between eye center and gaze point (normalized)
    # for a "looking at another face" commit. Below this, the gaze is too
    # short / too self-referential to trust as pointing at someone else.
    looking_at_min_distance: float = 0.10
    # Temporal smoothing: require this many consecutive frames pointing at the
    # same target (or camera) before emitting the event. 1 = no smoothing.
    looking_at_stability_frames: int = 1


settings = Settings()
