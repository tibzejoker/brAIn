from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VOICE_", env_file=".env", extra="ignore")

    port: int = 8765
    db_path: Path = Path("./data/voice.db")
    models_dir: Path = Path("./models")

    stt_model: str = "tiny"
    stt_backend: str = "auto"  # auto | mlx | faster-whisper
    language: str = "fr"

    diar_model: str = "streaming-sortformer-4spk-v2.1"

    # File name (relative to models_dir) of the speaker embedding ONNX.
    # Defaults to 3D-Speaker ERes2Net large (Chinese-trained, multilingual in
    # practice, ~90MB, much more discriminative than wespeaker.onnx on
    # French/cross-gender voices).
    embedding_model_file: str = "eres2net_large.onnx"
    match_threshold: float = 0.75
    uncertain_threshold: float = 0.60
    ema_decay: float = 0.2
    # Segments shorter than this are dropped before embedding. Set low (300)
    # to capture short utterances ("ok", "merci") at the cost of less reliable
    # speaker assignment for those — the embedder pads to 1 s internally.
    min_segment_ms: int = 300


settings = Settings()
