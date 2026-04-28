"""Tests for local_capture.LocalCapture.

Mocks `sounddevice` so they run without a real audio device. Run with the
voice venv:

    .venv/bin/python -m unittest tests.test_local_capture -v
"""
from __future__ import annotations

import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock

# Stub sounddevice before importing local_capture so the lazy import inside
# start() picks up our fake module.
_fake_sd = types.ModuleType("sounddevice")


class _FakeStream:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = False
        self.stopped = False
        self.closed = False
        # Hold the callback so tests can pump audio through it.
        self.callback = kwargs.get("callback")

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def close(self):
        self.closed = True


_fake_sd.InputStream = _FakeStream  # type: ignore[attr-defined]
_fake_sd.query_devices = MagicMock(return_value={"index": 1, "name": "Mock Mic"})  # type: ignore[attr-defined]
sys.modules["sounddevice"] = _fake_sd

# Importing path: the test file lives at server/tests/, the package is server/app/.
# unittest discovers from server/, so `app.local_capture` resolves naturally.
from app.local_capture import CaptureError, LocalCapture, list_input_devices  # noqa: E402


def _make_hub():
    hub = MagicMock()
    hub.active_session = None
    hub.start_session = AsyncMock()
    hub.stop_session = AsyncMock()
    hub.push_audio = AsyncMock()
    return hub


class LocalCaptureLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.hub = _make_hub()
        self.cap = LocalCapture(self.hub)

    async def asyncTearDown(self) -> None:
        if self.cap.is_running:
            await self.cap.stop()

    async def test_start_opens_stream_and_session(self) -> None:
        status = await self.cap.start(device=None, session_id="s1")
        self.assertTrue(self.cap.is_running)
        self.assertTrue(status["running"])
        self.assertEqual(status["sample_rate"], 16000)
        self.hub.start_session.assert_awaited_once_with("s1")
        self.assertTrue(self.cap._stream.started)

    async def test_start_is_idempotent_while_running(self) -> None:
        await self.cap.start(device=None, session_id="s1")
        first_stream = self.cap._stream
        await self.cap.start(device=None, session_id="s1")
        # Same stream, no second start_session call.
        self.assertIs(self.cap._stream, first_stream)
        self.hub.start_session.assert_awaited_once()

    async def test_audio_callback_frames_flow_to_hub(self) -> None:
        await self.cap.start(device=None, session_id="s1")
        stream = self.cap._stream
        frame = b"\x00\x01" * 512  # 1024 int16 samples
        # Simulate sounddevice's worker thread invoking the callback.
        stream.callback(frame, 1024, None, None)
        # Yield control so the loop runs the call_soon_threadsafe + drain task.
        for _ in range(5):
            await asyncio.sleep(0)
        self.hub.push_audio.assert_awaited()
        forwarded = self.hub.push_audio.await_args.args[0]
        self.assertEqual(forwarded, frame)

    async def test_stop_closes_stream_and_session(self) -> None:
        await self.cap.start(device=None, session_id="s1")
        stream = self.cap._stream
        status = await self.cap.stop()
        self.assertFalse(self.cap.is_running)
        self.assertFalse(status["running"])
        self.assertTrue(stream.stopped)
        self.assertTrue(stream.closed)
        self.hub.stop_session.assert_awaited()

    async def test_overflow_drops_oldest(self) -> None:
        await self.cap.start(device=None, session_id="s1")
        # Block the drain by stalling push_audio so the queue can saturate.
        gate = asyncio.Event()

        async def slow_push(_frame: bytes) -> None:
            await gate.wait()

        self.hub.push_audio.side_effect = slow_push
        stream = self.cap._stream
        # Push more frames than QUEUE_MAX (64) — ensures _enqueue trips the
        # QueueFull branch and increments dropped_frames.
        for i in range(80):
            stream.callback(bytes([i & 0xFF]) * 4, 2, None, None)
            await asyncio.sleep(0)
        gate.set()
        # Drain so push_audio doesn't keep stalling.
        for _ in range(20):
            await asyncio.sleep(0)
        self.assertGreater(self.cap._dropped_frames, 0)


class StartFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_sounddevice_raises_capture_error(self) -> None:
        # Force ImportError: setting a sys.modules entry to None makes Python's
        # import machinery raise. We use this rather than popping because the
        # real sounddevice library is installed in this venv and would shadow
        # the stub when popped.
        saved = sys.modules.get("sounddevice")
        sys.modules["sounddevice"] = None  # type: ignore[assignment]
        try:
            cap = LocalCapture(_make_hub())
            with self.assertRaises(CaptureError):
                await cap.start(device=None)
        finally:
            if saved is not None:
                sys.modules["sounddevice"] = saved
            else:
                sys.modules.pop("sounddevice", None)

    async def test_stream_open_failure_resets_state(self) -> None:
        hub = _make_hub()
        cap = LocalCapture(hub)
        original = _fake_sd.InputStream

        def boom(**_kwargs):
            raise OSError("device busy")

        _fake_sd.InputStream = boom  # type: ignore[attr-defined]
        try:
            with self.assertRaises(CaptureError):
                await cap.start(device=None)
        finally:
            _fake_sd.InputStream = original  # type: ignore[attr-defined]
        self.assertFalse(cap.is_running)
        # Session was started before the failure, then must be torn down.
        hub.start_session.assert_awaited_once()
        hub.stop_session.assert_awaited_once()


class DeviceListingTests(unittest.TestCase):
    def test_list_input_devices_filters_outputs(self) -> None:
        _fake_sd.query_devices = MagicMock(return_value=[  # type: ignore[attr-defined]
            {"name": "Speakers", "max_input_channels": 0, "default_samplerate": 48000, "hostapi": 0},
            {"name": "MacBook Mic", "max_input_channels": 1, "default_samplerate": 48000, "hostapi": 0},
            {"name": "USB Mic", "max_input_channels": 2, "default_samplerate": 44100, "hostapi": 0},
        ])
        devs = list_input_devices()
        self.assertEqual([d["name"] for d in devs], ["MacBook Mic", "USB Mic"])
        self.assertEqual(devs[0]["id"], 1)


if __name__ == "__main__":
    unittest.main()
