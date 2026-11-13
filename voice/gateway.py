"""The voice gateway: the one door into the voice GPU.

Clear Ops (on Fly) connects here over a WebSocket with the shared VOICE_KEY. It sends raw PCM
(16-bit little-endian, mono, 24 kHz) from Paul's microphone and gets the same back for the
speaker, plus a few JSON events. Behind it, on the same machine, Kyutai's Unmute backend does
speech-to-text, turn taking and text-to-speech; Unmute speaks Ogg Opus, so the gateway does the
Opus encoding and decoding and Clear Ops never has to.

Unmute itself has no authentication, so it listens on loopback only and this gateway is the
only thing exposed. Recording is off (KYUTAI_RECORDINGS_DIR is never set, allow_recording false).
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

import numpy as np
import sphn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

log = logging.getLogger("voice-gateway")

SAMPLE_RATE = 24000
# Events from Unmute that Clear Ops cares about; everything else stays here.
FORWARD_EVENTS = {
    "conversation.item.input_audio_transcription.delta",
    "response.text.delta",
    "response.created",
    "unmute.interrupted_by_vad",
    "input_audio_buffer.speech_started",
    "error",
}

DEFAULT_INSTRUCTIONS = (
    "You are Cleo, the voice of ClearOps, Paul's chief of staff, speaking with him by voice. "
    "Keep answers short and natural, in British English."
)


def authorised(header: str | None, key: str) -> bool:
    """Bearer token check in constant time. No key configured means nobody gets in."""
    if not key or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer ") :].encode(), key.encode())


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data[: len(data) - len(data) % 2], dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(pcm: np.ndarray) -> bytes:
    return (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class Transcoder:
    """PCM in to Ogg Opus for Unmute, Ogg Opus from Unmute to PCM out."""

    def __init__(self) -> None:
        self.writer = sphn.OpusStreamWriter(SAMPLE_RATE)
        self.reader = sphn.OpusStreamReader(SAMPLE_RATE)

    def encode(self, pcm16: bytes) -> bytes:
        return self.writer.append_pcm(pcm16_to_float(pcm16))

    def decode(self, ogg: bytes) -> bytes:
        pcm = self.reader.append_bytes(ogg)
        return float_to_pcm16(pcm) if pcm is not None and len(pcm) else b""


async def wait_until_healthy(
    health: Callable[[], Awaitable[dict[str, Any]]],
    notify: Callable[[dict[str, Any]], Awaitable[None]],
    timeout_s: float = 600.0,
    interval_s: float = 2.0,
) -> dict[str, Any]:
    """Polls Unmute's /v1/health until it says ok, telling the caller every 15 seconds while it waits."""
    start = time.monotonic()
    last_note = -1e9
    last: dict[str, Any] = {}
    while time.monotonic() - start < timeout_s:
        try:
            last = await health()
            if last.get("ok"):
                return last
        except Exception as err:  # the backend is still starting
            last = {"ok": False, "error": str(err)}
        if time.monotonic() - last_note >= 15:
            last_note = time.monotonic()
            await notify({"type": "status", "state": "warming", "detail": last, "waited_s": round(time.monotonic() - start)})
        await asyncio.sleep(interval_s)
    raise TimeoutError(f"voice backend not healthy after {timeout_s:.0f}s: {last}")


def build_app(
    key: str,
    backend_ws: str = "ws://127.0.0.1:8000/v1/realtime",
    health: Callable[[], Awaitable[dict[str, Any]]] | None = None,
    connect: Callable[..., Any] = websockets.connect,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    async def default_health() -> dict[str, Any]:
        import httpx

        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(backend_ws.replace("ws://", "http://").replace("/v1/realtime", "/v1/health"))
            return r.json()

    check = health or default_health

    @app.get("/health")
    async def ping() -> dict[str, Any]:
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(client: WebSocket) -> None:
        if not authorised(client.headers.get("authorization"), key):
            await client.close(code=4401, reason="unauthorised")
            return
        await client.accept()
        try:
            start = json.loads(await client.receive_text())
        except Exception:
            await client.close(code=4400, reason="expected a start message")
            return

        async def send_json(obj: dict[str, Any]) -> None:
            await client.send_text(json.dumps(obj))

        try:
            await wait_until_healthy(check, send_json)
        except TimeoutError as err:
            await send_json({"type": "status", "state": "failed", "detail": str(err)})
            await client.close(code=1011, reason="backend not ready")
            return

        coder = Transcoder()
        async with connect(backend_ws, subprotocols=["realtime"], max_size=None) as backend:
            session = {
                "instructions": {"type": "constant", "text": start.get("instructions") or DEFAULT_INSTRUCTIONS},
                "allow_recording": False,
            }
            if start.get("voice"):
                session["voice"] = start["voice"]
            await backend.send(json.dumps({"type": "session.update", "session": session}))
            await send_json({"type": "status", "state": "ready"})

            async def upstream() -> None:
                while True:
                    msg = await client.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    data = msg.get("bytes")
                    if data:
                        ogg = coder.encode(data)
                        if ogg:
                            await backend.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(ogg).decode()}))

            async def downstream() -> None:
                async for raw in backend:
                    event = json.loads(raw)
                    kind = event.get("type")
                    if kind == "response.audio.delta":
                        pcm = coder.decode(base64.b64decode(event["delta"]))
                        if pcm:
                            await client.send_bytes(pcm)
                    elif kind in FORWARD_EVENTS:
                        await send_json({"type": "event", "event": event})

            tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            except WebSocketDisconnect:
                pass
            finally:
                for t in tasks:
                    t.cancel()
        try:
            await client.close()
        except Exception:
            pass

    return app


def app_from_env() -> FastAPI:
    return build_app(os.environ.get("VOICE_KEY", ""))
