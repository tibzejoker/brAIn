"""Minimum repro: bare FastAPI + WebSocket route, no SDK."""
from fastapi import FastAPI, WebSocket

app = FastAPI()


@app.websocket("/brain/ws")
async def ws_handler(ws: WebSocket) -> None:
    print("HANDLER CALLED", flush=True)
    await ws.accept()
    print("HANDLER ACCEPTED", flush=True)
    await ws.send_text("hello")
    await ws.close()
    print("HANDLER CLOSED", flush=True)
