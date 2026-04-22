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

    # Moondream 2 via transformers. Revision 2025-01-09 is the first that ships
    # the detect_gaze method. Model weights (~3.8 GB safetensors) are cached under
    # models_dir via HF snapshot_download.
    moondream_repo: str = "vikhyatk/moondream2"
    moondream_revision: str = "2025-01-09"
    # "mps" (Apple Silicon GPU), "cuda", or "cpu". Default picks mps if available.
    moondream_device: str = "auto"
    # Moondream's accurate path runs 20 samples per face — ~10-20x slower but
    # more stable. Off by default (fine for 1-2 FPS realtime).
    gaze_accurate: bool = False

    # ArcFace cosine-similarity thresholds. 0.42 is the classic safe default on
    # L2-normalized embeddings; raise for stricter matching (more new profiles).
    match_threshold: float = 0.42
    uncertain_threshold: float = 0.30
    ema_decay: float = 0.15

    # When deciding "face A looks at face B", inflate B's bbox by this fraction
    # of the image size (head moves, gaze is approximate). 5% = forgiving.
    looking_at_margin: float = 0.05


settings = Settings()
