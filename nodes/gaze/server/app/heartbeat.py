"""Parent-process heartbeat watchdog.

When this server is spawned as a child of the brAIn API node, the parent's
PID is passed via env var (default `BRAIN_PARENT_PID`). A daemon thread
polls `os.kill(pid, 0)` every few seconds — that signals nothing but raises
`ProcessLookupError` if the parent is gone.

If the parent dies (clean shutdown, crash, SIGKILL, OOM), we self-terminate
so we never become an orphan. Standalone runs (no env var) are a no-op.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time

log = logging.getLogger(__name__)

DEFAULT_ENV_VAR = "BRAIN_PARENT_PID"
DEFAULT_INTERVAL_S = 2.0


class ParentHeartbeat:
    def __init__(
        self,
        parent_pid: int,
        interval_s: float = DEFAULT_INTERVAL_S,
        on_orphan=None,  # callable | None — defaults to sys.exit-style suicide
    ) -> None:
        self._parent_pid = parent_pid
        self._interval_s = interval_s
        self._on_orphan = on_orphan or _default_suicide
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="brain-heartbeat", daemon=True
        )
        self._thread.start()
        log.info("parent heartbeat started (pid=%d, interval=%.1fs)",
                 self._parent_pid, self._interval_s)

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=self._interval_s + 1)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self._interval_s):
            if not _is_alive(self._parent_pid):
                log.warning("parent pid=%d gone — self-terminating",
                            self._parent_pid)
                try:
                    self._on_orphan()
                except SystemExit:
                    raise
                except Exception:
                    log.exception("on_orphan callback failed")
                return


def _is_alive(pid: int) -> bool:
    if sys.platform == "win32":
        # On Windows, signal 0 is CTRL_C_EVENT — calling os.kill(pid, 0) would
        # broadcast Ctrl+C to the parent's console group and kill every sibling
        # process attached to it. Use OpenProcess + GetExitCodeProcess instead.
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = ctypes.c_void_p
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        exit_code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
        kernel32.CloseHandle(h)
        return bool(ok) and exit_code.value == STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we can't signal it — still alive.
        return True
    return True


def _default_suicide() -> None:
    # os._exit avoids running atexit hooks / waiting on background tasks
    # that may themselves be blocked on the dead parent. We're already in
    # an orphaned state — fast exit is the safe play.
    time.sleep(0)  # gives logs a chance to flush
    os._exit(0)


def maybe_start_from_env(env_var: str = DEFAULT_ENV_VAR) -> ParentHeartbeat | None:
    """Read parent PID from env. No-op (returns None) when absent or invalid."""
    raw = os.environ.get(env_var)
    if not raw:
        return None
    try:
        pid = int(raw)
    except ValueError:
        log.warning("invalid %s=%r — heartbeat disabled", env_var, raw)
        return None
    if pid <= 0 or pid == os.getpid():
        log.warning("nonsensical %s=%d — heartbeat disabled", env_var, pid)
        return None
    hb = ParentHeartbeat(parent_pid=pid)
    hb.start()
    return hb
