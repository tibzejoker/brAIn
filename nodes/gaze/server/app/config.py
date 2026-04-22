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
    looking_at_stability_frames: int = 2


settings = Settings()
