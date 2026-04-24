from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INTENT_", env_file=".env", extra="ignore")

    port: int = 8767
    db_path: Path = Path("./data/intent.db")

    # Upstream URLs — the intent proxy consumes both.
    voice_url: str = "http://127.0.0.1:8765"
    gaze_url: str = "http://127.0.0.1:8766"
    # Voice session id used when subscribing to /ws/events. Voice node is
    # session-scoped; we stick to "default" like the voice web UI does.
    voice_session: str = "default"

    # Correlation window: when a voice segment starts at t_start and ends at
    # t_end, look at gaze events from the same linked person in
    # [t_start − pre, t_end + post]. The pre-buffer catches gaze that
    # stabilizes just before the subject starts speaking.
    corr_pre_s: float = 0.5
    corr_post_s: float = 0.3

    # Gaze events lag behind the actual eye movement by the gaze engine's
    # detection frame interval + stability check. We backdate each event's
    # interval by this amount so a transition committed at 49.0s is
    # attributed from roughly 48.0s onwards, matching the moment the
    # subject actually moved their gaze. Tune up if your webcam fps is
    # low or stability_frames is high.
    gaze_state_lag_s: float = 1.0

    # Gaze poll cadence (seconds). Gaze node only records events during
    # webcam bursts so we don't need high frequency here.
    gaze_poll_interval_s: float = 0.5

    # Rolling timeline retention per person (seconds). Older entries get
    # pruned from the in-memory store.
    timeline_retention_s: float = 300.0


settings = Settings()
