"""Gateway tests against a fake Unmute backend. Run: python3 -m pytest voice/test_gateway.py

No GPU and no Modal: the fake backend speaks the same events Unmute does (Ogg Opus in base64),
and the gateway runs under uvicorn on loopback.
"""

import asyncio
import base64
import json
import socket
import sys
from pathlib import Path

import numpy as np
import pytest
import sphn
import uvicorn
import websockets

sys.path.insert(0, str(Path(__file__).parent))
import gateway  # noqa: E402

KEY = "test-voice-key"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeUnmute:
    """Records what it was sent; answers each Opus chunk with an audio delta and one transcript event."""

    def __init__(self) -> None:
        self.session = None
        self.audio_chunks = 0
        self.first_bos = None
        self.reader = sphn.OpusStreamReader(24000)
        self.writer = sphn.OpusStreamWriter(24000)
        self.decoded = 0

    async def handler(self, ws) -> None:
        assert ws.subprotocol == "realtime"
        async for raw in ws:
            ev = json.loads(raw)
            if ev["type"] == "session.update":
                self.session = ev["session"]
                await ws.send(json.dumps({"type": "conversation.item.input_audio_transcription.delta", "delta": "hello", "start_time": 0.0}))
                await ws.send(json.dumps({"type": "unmute.additional_outputs", "args": {}}))  # not forwarded
            elif ev["type"] == "input_audio_buffer.append":
                ogg = base64.b64decode(ev["audio"])
                if self.first_bos is None:
                    self.first_bos = bool(ogg[5] & 2)
                self.audio_chunks += 1
                pcm = self.reader.append_bytes(ogg)
                self.decoded += len(pcm)
                tone = (0.2 * np.sin(np.arange(1920) / 10)).astype(np.float32)
                out = self.writer.append_pcm(tone)
                if out:
                    await ws.send(json.dumps({"type": "response.audio.delta", "delta": base64.b64encode(out).decode()}))


async def run_case(key_header: str | None):
    fake = FakeUnmute()
    bport, gport = free_port(), free_port()
    backend = await websockets.serve(fake.handler, "127.0.0.1", bport, subprotocols=["realtime"])

    async def healthy():
        return {"ok": True}

    app = gateway.build_app(KEY, backend_ws=f"ws://127.0.0.1:{bport}/v1/realtime", health=healthy)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=gport, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    result = {"fake": fake, "events": [], "pcm": 0, "closed": None}
    headers = {"Authorization": key_header} if key_header else {}
    try:
        async with websockets.connect(f"ws://127.0.0.1:{gport}/ws", additional_headers=headers) as ws:
            await ws.send(json.dumps({"type": "start", "voice": "v.wav", "instructions": "be brief"}))
            ready = json.loads(await ws.recv())
            result["events"].append(ready)
            tone = (8000 * np.sin(np.arange(24000) / 7)).astype("<i2").tobytes()
            for i in range(0, len(tone), 960):  # 20 ms frames
                await ws.send(tone[i : i + 960])
            deadline = asyncio.get_event_loop().time() + 3
            while asyncio.get_event_loop().time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.recv(), 0.5)
                except asyncio.TimeoutError:
                    break
                if isinstance(msg, bytes):
                    result["pcm"] += len(msg)
                else:
                    result["events"].append(json.loads(msg))
    except websockets.exceptions.ConnectionClosedError as e:
        result["closed"] = e.rcvd.code if e.rcvd else None
    except websockets.exceptions.InvalidStatus as e:
        result["closed"] = e.response.status_code
    finally:
        server.should_exit = True
        await task
        backend.close()
    return result


def test_wrong_key_is_refused():
    r = asyncio.run(run_case("Bearer nope"))
    assert r["closed"] in (4401, 403)
    assert r["fake"].session is None


def test_no_key_is_refused():
    r = asyncio.run(run_case(None))
    assert r["closed"] in (4401, 403)


def test_audio_round_trip():
    r = asyncio.run(run_case(f"Bearer {KEY}"))
    fake = r["fake"]
    assert r["events"][0] == {"type": "status", "state": "ready"}
    assert fake.session["voice"] == "v.wav"
    assert fake.session["instructions"] == {"type": "constant", "text": "be brief"}
    assert fake.session["allow_recording"] is False
    assert fake.first_bos is True  # Unmute ignores audio until it sees the Ogg start page
    assert fake.decoded > 20000  # about a second of our audio reached the backend
    assert r["pcm"] > 0  # and speech came back as PCM
    kinds = [e.get("event", {}).get("type") for e in r["events"][1:]]
    assert "conversation.item.input_audio_transcription.delta" in kinds
    assert "unmute.additional_outputs" not in kinds


def test_authorised_is_constant_time_and_strict():
    assert gateway.authorised(f"Bearer {KEY}", KEY)
    assert not gateway.authorised(KEY, KEY)
    assert not gateway.authorised(f"Bearer {KEY}", "")
    assert not gateway.authorised(None, KEY)


def test_waits_for_health_and_reports_warming():
    calls = {"n": 0}
    notes = []

    async def health():
        calls["n"] += 1
        return {"ok": calls["n"] >= 3}

    async def notify(n):
        notes.append(n)

    asyncio.run(gateway.wait_until_healthy(health, notify, timeout_s=5, interval_s=0.01))
    assert calls["n"] == 3
    assert notes and notes[0]["state"] == "warming"

    async def never():
        return {"ok": False}

    with pytest.raises(TimeoutError):
        asyncio.run(gateway.wait_until_healthy(never, notify, timeout_s=0.05, interval_s=0.01))
