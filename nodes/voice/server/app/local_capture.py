"""Local microphone capture.

Bypasses the browser/WS audio path: opens the host microphone directly via
sounddevice and feeds int16 PCM frames into the same SessionHub the WS
endpoint uses. Lets the brAIn UI (or any other controller) drive the voice
pipeline without forcing a web frontend to stay open just for getUserMedia.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .ws import SessionHub

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCKSIZE = 1024  # ~64 ms at 16 kHz; matches the cadence the WS path was using
QUEUE_MAX = 64    # ~4 s of audio in flight; we drop oldest on overflow


class CaptureError(RuntimeError):
    pass


class LocalCapture:
    """Owns the host audio device and pushes frames into a SessionHub.

    One instance per server. Single active stream at a time — calling start()
    while running is a no-op that returns the current state.
    """

    def __init__(self, hub: "SessionHub") -> None:
        self._hub = hub
        self._stream = None  # sd.InputStream | None — typed loosely so the import stays lazy
        self._device: int | None = None
        self._device_name: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[bytes] | None = None
        self._consumer: asyncio.Task[None] | None = None
        self._dropped_frames = 0

    @property
    def is_running(self) -> bool:
        return self._stream is not None

    def status(self) -> dict[str, object]:
        return {
            "running": self.is_running,
            "device": self._device,
            "device_name": self._device_name,
            "session_id": self._hub.active_session,
            "sample_rate": SAMPLE_RATE,
            "dropped_frames": self._dropped_frames,
        }

    async def start(self, device: int | str | None, session_id: str = "default") -> dict[str, object]:
        # Already running on the same device → no-op. Different device →
        # stop the current stream first so the user's selection actually
        # takes effect (Windows/Mac sounddevice fall back to the host
        # default if you don't explicitly close the previous stream).
        if self._stream is not None:
            if device is None or device == self._device:
                return self.status()
            await self.stop()

        try:
            import sounddevice as sd
        except ImportError as e:
            raise CaptureError(
                "sounddevice is not installed in this environment. "
                "Install it via `pip install sounddevice` or `pip install -r requirements.txt`."
            ) from e

        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._dropped_frames = 0

        await self._hub.start_session(session_id)

        def _audio_callback(indata, frames, time_info, status) -> None:  # noqa: ANN001
            if status:
                log.warning("sounddevice stream status: %s", status)
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._enqueue, bytes(indata))
            except RuntimeError:
                pass  # loop shutting down

        try:
            stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                blocksize=BLOCKSIZE,
                dtype="int16",
                channels=CHANNELS,
                device=device,
                callback=_audio_callback,
            )
            stream.start()
        except Exception as e:
            await self._hub.stop_session()
            self._loop = None
            self._queue = None
            raise CaptureError(f"failed to open audio device: {e}") from e

        self._stream = stream
        self._device, self._device_name = _resolve_device_info(sd, device)
        self._consumer = asyncio.create_task(self._drain())
        log.info("local capture started (device=%s name=%r session=%s)",
                 self._device, self._device_name, session_id)
        return self.status()

    async def stop(self) -> dict[str, object]:
        if self._stream is None:
            return self.status()

        stream, self._stream = self._stream, None
        try:
            stream.stop()
            stream.close()
        except Exception:
            log.exception("error closing audio stream (continuing)")

        consumer, self._consumer = self._consumer, None
        if consumer is not None:
            consumer.cancel()
            try:
                await consumer
            except (asyncio.CancelledError, Exception):
                pass

        self._queue = None
        self._loop = None
        self._device = None
        self._device_name = None

        await self._hub.stop_session()
        log.info("local capture stopped (dropped %d frames during session)", self._dropped_frames)
        return self.status()

    def _enqueue(self, frame: bytes) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Drop oldest to keep latency bounded — losing 64 ms of audio
            # is preferable to lagging behind real time when the engine
            # stalls (e.g., during model warm-up).
            try:
                queue.get_nowait()
                queue.put_nowait(frame)
                self._dropped_frames += 1
            except asyncio.QueueEmpty:
                pass

    async def _drain(self) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            while True:
                frame = await queue.get()
                try:
                    await self._hub.push_audio(frame)
                except Exception:
                    log.exception("hub.push_audio failed (continuing)")
        except asyncio.CancelledError:
            pass


def _resolve_device_info(sd, device: int | str | None) -> tuple[int | None, str | None]:  # noqa: ANN001
    try:
        if device is None:
            info = sd.query_devices(kind="input")
            return (info.get("index"), info.get("name"))
        info = sd.query_devices(device)
        return (info.get("index"), info.get("name"))
    except Exception:
        return (None, None)


def list_input_devices() -> list[dict[str, object]]:
    try:
        import sounddevice as sd
    except ImportError as e:
        raise CaptureError("sounddevice is not installed") from e

    devices = sd.query_devices()
    out: list[dict[str, object]] = []
    for i, d in enumerate(devices):
        if d.get("max_input_channels", 0) <= 0:
            continue
        out.append({
            "id": i,
            "name": d.get("name"),
            "max_input_channels": d.get("max_input_channels"),
            "default_samplerate": d.get("default_samplerate"),
            "hostapi": d.get("hostapi"),
        })
    return out
