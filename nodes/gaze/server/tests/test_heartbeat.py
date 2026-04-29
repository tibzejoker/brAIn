"""Tests for heartbeat.ParentHeartbeat.

We can't easily kill a real process from inside a test, so the watchdog
target uses a callback we can flip from the test side. Run with:

    .venv/bin/python -m unittest tests.test_heartbeat -v
"""
from __future__ import annotations

import os
import threading
import unittest
from unittest.mock import patch

from app.heartbeat import ParentHeartbeat, _is_alive, maybe_start_from_env


class HeartbeatTests(unittest.TestCase):
    def test_alive_returns_true_for_self(self) -> None:
        self.assertTrue(_is_alive(os.getpid()))

    def test_alive_returns_false_for_unused_pid(self) -> None:
        # PID 1 is init / launchd — always alive on macOS/Linux. We need an
        # unused PID. Walk down from 2^22 and find one that ProcessLookupError's.
        for candidate in range(4194303, 100, -1):
            try:
                os.kill(candidate, 0)
            except ProcessLookupError:
                self.assertFalse(_is_alive(candidate))
                return
            except PermissionError:
                continue
        self.skipTest("could not find an unused PID to probe")

    def test_callback_fires_when_parent_disappears(self) -> None:
        fired = threading.Event()

        # Patch _is_alive at the module level so the watchdog sees the
        # parent as "gone" on its first tick, regardless of the real pid.
        with patch("app.heartbeat._is_alive", return_value=False):
            hb = ParentHeartbeat(
                parent_pid=os.getpid(),
                interval_s=0.05,
                on_orphan=fired.set,
            )
            hb.start()
            self.assertTrue(fired.wait(timeout=2.0), "callback never fired")
            hb.stop()

    def test_no_callback_while_parent_alive(self) -> None:
        fired = threading.Event()
        hb = ParentHeartbeat(
            parent_pid=os.getpid(),  # ourselves: definitely alive
            interval_s=0.05,
            on_orphan=fired.set,
        )
        hb.start()
        try:
            self.assertFalse(fired.wait(timeout=0.3), "fired with live parent")
        finally:
            hb.stop()

    def test_stop_is_idempotent_and_quick(self) -> None:
        hb = ParentHeartbeat(parent_pid=os.getpid(), interval_s=0.05)
        hb.start()
        hb.stop()
        hb.stop()  # second stop must not raise
        self.assertIsNone(hb._thread)

    def test_double_start_is_noop(self) -> None:
        hb = ParentHeartbeat(parent_pid=os.getpid(), interval_s=0.05)
        hb.start()
        first_thread = hb._thread
        hb.start()
        self.assertIs(hb._thread, first_thread)
        hb.stop()


class MaybeStartFromEnvTests(unittest.TestCase):
    def test_no_env_returns_none(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BRAIN_PARENT_PID", None)
            self.assertIsNone(maybe_start_from_env())

    def test_invalid_env_returns_none(self) -> None:
        with patch.dict(os.environ, {"BRAIN_PARENT_PID": "not-a-number"}):
            self.assertIsNone(maybe_start_from_env())

    def test_self_pid_rejected(self) -> None:
        # Watching ourselves would be silly and the heartbeat refuses it.
        with patch.dict(os.environ, {"BRAIN_PARENT_PID": str(os.getpid())}):
            self.assertIsNone(maybe_start_from_env())

    def test_valid_env_starts_thread(self) -> None:
        # Use PID 1 (init) — always alive — so the watchdog starts cleanly.
        with patch.dict(os.environ, {"BRAIN_PARENT_PID": "1"}):
            hb = maybe_start_from_env()
            self.assertIsNotNone(hb)
            try:
                assert hb is not None
                self.assertIsNotNone(hb._thread)
                self.assertTrue(hb._thread.is_alive())
            finally:
                if hb is not None:
                    hb.stop()


if __name__ == "__main__":
    unittest.main()
