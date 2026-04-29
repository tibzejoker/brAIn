"""Core `BrainNode` class — the brAIn web SDK in one file.

Usage (FastAPI):

    from fastapi import FastAPI
    from brain_web import BrainNode, Message, on_message

    app = FastAPI()
    node = BrainNode(auth_token_env="CALC_TOKEN")

    @node.on("calc.request")
    async def on_calc(msg: Message) -> None:
        expr = msg.payload["content"]
        result = eval(expr, {"__builtins__": {}})  # demo only
        await node.publish("calc.result", str(result), criticality=2)

    node.attach(app)  # adds the /brain/ws WebSocket route

The framework's WebRunner connects, sends `{type:"messages",...}`
frames; each one fans out to the registered handlers.
"""

import asyncio
import inspect
import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("brain_web")


@dataclass(slots=True)
class Message:
    id: str
    from_: str
    topic: str
    type: str
    criticality: float
    payload: dict[str, Any]
    timestamp: float
    metadata: dict[str, Any] | None = None


MessageHandler = Callable[[Message], Awaitable[None]]


def on_message(topic: str):  # noqa: ANN201 — decorator
    """Standalone decorator for module-level handlers; pair with BrainNode.collect()."""
    def deco(fn: MessageHandler) -> MessageHandler:
        fn.__brain_topic__ = topic  # type: ignore[attr-defined]
        return fn
    return deco


@dataclass
class BrainNode:
    """Minimal protocol implementation.

    Holds the active WebSocket (set by the runner via `attach()`),
    routes incoming `messages` frames to handlers, and emits the
    framework-bound frames (`publish` / `subscribe` / `sleep` / `log`).
    """

    auth_token_env: str | None = None
    handlers: dict[str, list[MessageHandler]] = field(default_factory=dict)
    _ws: Any = field(default=None, repr=False)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def on(self, topic: str) -> Callable[[MessageHandler], MessageHandler]:
        """Decorator: register a handler for a specific topic."""
        def deco(fn: MessageHandler) -> MessageHandler:
            self.handlers.setdefault(topic, []).append(fn)
            return fn
        return deco

    def collect(self, *fns: Callable[..., Any]) -> None:
        """Bulk-register module-level handlers decorated with `@on_message`."""
        for fn in fns:
            topic = getattr(fn, "__brain_topic__", None)
            if topic:
                self.handlers.setdefault(topic, []).append(fn)

    def attach(self, app: Any, path: str = "/brain/ws") -> None:
        """Attach the WebSocket route to a FastAPI/Starlette app.

        The endpoint is closed over `self` and given an explicit
        `WebSocket` parameter annotation — FastAPI inspects the signature
        on dispatch and silently 403s endpoints whose parameter type
        isn't recognisable as a WebSocket.
        """
        from fastapi import WebSocket, WebSocketDisconnect
        node = self  # capture into the closure

        async def _brain_ws(ws: WebSocket) -> None:
            if not node._authorize(ws):
                await ws.accept()
                await ws.close(code=4401)
                return
            await ws.accept()
            node._ws = ws
            log.info("brAIn web node: framework connected")
            try:
                while True:
                    raw = await ws.receive_text()
                    await node._on_frame(raw)
            except WebSocketDisconnect:
                log.info("brAIn web node: framework disconnected")
            except Exception:  # noqa: BLE001
                log.exception("brAIn web node: ws error")
            finally:
                node._ws = None

        app.add_api_websocket_route(path, _brain_ws)

    def _authorize(self, ws: Any) -> bool:
        if self.auth_token_env is None:
            return True
        expected = os.environ.get(self.auth_token_env)
        if not expected:
            log.warning("auth env var %s not set; rejecting", self.auth_token_env)
            return False
        # Starlette lowercases all headers; ws.headers is a Mapping[str,str].
        # Use a manual case-insensitive lookup so the SDK works regardless
        # of which ASGI server normalises (or doesn't) the upgrade headers.
        header = ""
        for k, v in dict(ws.headers).items():
            if k.lower() == "authorization":
                header = v
                break
        if not header.lower().startswith("bearer "):
            log.warning("missing/invalid Authorization header on /brain/ws")
            return False
        token = header[7:].strip()
        if token != expected:
            log.warning("bearer token mismatch on /brain/ws")
            return False
        return True

    async def _on_frame(self, raw: str) -> None:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("malformed frame")
            return
        ftype = frame.get("type")
        if ftype == "messages":
            for raw_msg in frame.get("messages", []):
                msg = _parse_message(raw_msg)
                handlers = self.handlers.get(msg.topic, [])
                if not handlers:
                    log.debug("no handler for topic %s", msg.topic)
                    continue
                # Fan out concurrently; each handler is independent.
                await asyncio.gather(*(_safe_call(h, msg) for h in handlers))
        elif ftype == "ping":
            await self._send({"type": "pong"})
        else:
            log.debug("ignoring frame type %s", ftype)

    async def _send(self, frame: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            log.debug("no live ws; dropping frame %s", frame.get("type"))
            return
        async with self._send_lock:
            try:
                await ws.send_text(json.dumps(frame))
            except Exception:  # noqa: BLE001
                log.exception("send failed")

    # ── public API for handlers ───────────────────────────────────────
    async def publish(
        self,
        topic: str,
        content: str,
        criticality: float = 1.0,
        message_type: str = "text",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        await self._send({
            "type": "publish",
            "topic": topic,
            "payload": {"content": content},
            "criticality": criticality,
            "message_type": message_type,
            "metadata": metadata,
        })

    async def subscribe(self, topic: str, max_size: int | None = None) -> None:
        frame: dict[str, Any] = {"type": "subscribe", "topic": topic}
        if max_size is not None:
            frame["mailbox"] = {"max_size": max_size}
        await self._send(frame)

    async def unsubscribe(self, topic: str) -> None:
        await self._send({"type": "unsubscribe", "topic": topic})

    async def sleep(self, conditions: list[dict[str, Any]]) -> None:
        await self._send({"type": "sleep", "conditions": conditions})

    async def log(self, level: str, message: str, data: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"type": "log", "level": level, "message": message}
        if data is not None:
            frame["data"] = data
        await self._send(frame)


def _parse_message(raw: dict[str, Any]) -> Message:
    return Message(
        id=raw.get("id", ""),
        from_=raw.get("from", ""),
        topic=raw.get("topic", ""),
        type=raw.get("type", "text"),
        criticality=raw.get("criticality", 0),
        payload=raw.get("payload", {}),
        timestamp=raw.get("timestamp", 0),
        metadata=raw.get("metadata"),
    )


async def _safe_call(handler: MessageHandler, msg: Message) -> None:
    try:
        result = handler(msg)
        if inspect.isawaitable(result):
            await result
    except Exception:  # noqa: BLE001
        log.exception("handler for %s raised", msg.topic)
