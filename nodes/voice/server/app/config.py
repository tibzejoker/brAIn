from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VOICE_", env_file=".env", extra="ignore")

    port: int = 8765
    db_path: Path = Path("./data/voice.db")
    models_dir: Path = Path("./models")

    stt_model: str = "medium"
    stt_backend: str = "auto"  # auto | mlx | faster-whisper
    language: str = "fr"

    diar_model: str = "streaming-sortformer-4spk-v2.1"

    # File name (relative to models_dir) of the speaker embedding ONNX.
    # Defaults to 3D-Speaker ERes2Net large (Chinese-trained, multilingual in
    # practice, ~90MB, much more discriminative than wespeaker.onnx on
    # French/cross-gender voices).
    embedding_model_file: str = "eres2net_large.onnx"
    # Thresholds calibrated to ERes2Net-large cosine outputs, which sit in a
    # lower range than ArcFace. Measured on a small corpus of French voices:
    # intra-speaker pairs spread p5≈0.16 / median≈0.36 / max≈0.58, while
    # distinct speakers top out around 0.30 on their worst pair. match=0.40
    # catches the bulk of same-speaker matches without cross-linking, and
    # uncertain=0.25 keeps provisional matches alive for borderline short
    # segments that would otherwise spawn a ghost profile.
    match_threshold: float = 0.40
    uncertain_threshold: float = 0.25
    ema_decay: float = 0.2
    # Segments shorter than this are dropped before embedding. Set low (300)
    # to capture short utterances ("ok", "merci") at the cost of less reliable
    # speaker assignment for those — the embedder pads to 1 s internally.
    min_segment_ms: int = 300


settings = Settings()
