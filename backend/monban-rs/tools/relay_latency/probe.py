"""Replay the same synthetic delivery utterance over relay v2 (Python 3.11+, websockets 15+)."""
import argparse
import asyncio
import getpass
import hashlib
import json
import math
import os
import struct
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import websockets


async def measure(url, key):
    pcm = Path(__file__).with_name("delivery.s16le").read_bytes()
    digest = hashlib.sha256(pcm).hexdigest()
    if digest != "ea1bafa3d4b12b5124499ea97b26c10887358bc77970a269778087bff9607753":
        raise ValueError("fixture hash mismatch")
    visit = str(uuid.uuid4())
    started = time.monotonic()

    def event(name, **fields):
        print(json.dumps(dict(event=name, visit_id=visit,
                              utc=datetime.now(timezone.utc).isoformat(),
                              ms=round((time.monotonic() - started) * 1000, 2),
                              **fields), ensure_ascii=False), flush=True)

    event("probe_start", sha256=digest)
    async with websockets.connect(url, additional_headers={"Authorization": "Bearer " + key},
                                  compression=None, proxy=None, open_timeout=15) as ws:
        async def send(kind, **fields):
            await ws.send(json.dumps(dict(type=kind, **fields)))

        await send("start", protocol_version=2, visit_id=visit, mode="normal")
        turn = frames = samples = 0
        voiced = False
        input_done = False
        answered = False
        playback_start = 0
        async for message in ws:
            if isinstance(message, bytes):
                if not message or len(message) % 2:
                    raise ValueError("invalid PCM")
                frames += 1
                samples += len(message) // 2
                if frames == 1:
                    event("first_pcm", turn=turn)
                if frames == 32:
                    event("playback_buffer_ready", turn=turn)
                if not voiced:
                    rms = math.sqrt(sum(x*x for (x,) in struct.iter_unpack("<h", message)) /
                                    (len(message) // 2))
                    if rms >= 160:
                        voiced = True
                        event("first_voiced", turn=turn)
                await send("audio_ack", turn_id=turn, output_id=turn, frames=frames)
                continue
            data = json.loads(message)
            kind = data["type"]
            if kind == "ready":
                await send("call_started", turn_id=0)
                event("call_started")
            elif kind == "output_start":
                turn = data["turn_id"]
                frames = samples = 0
                voiced = False
                playback_start = time.monotonic()
            elif kind == "output_end":
                if data.get("frames") != frames or data.get("samples") != samples:
                    raise ValueError("output counts mismatch")
                if frames < 32:
                    event("playback_buffer_ready", turn=turn)
                event("output_end", turn=turn, frames=frames, samples=samples)
                await asyncio.sleep(max(0, samples / 16000 - (time.monotonic() - playback_start)))
                await send("playback_done", turn_id=turn, output_id=turn, frames=frames, samples=samples)
                if input_done and turn > 0:
                    answered = voiced
            elif kind == "listen" and not input_done:
                await asyncio.sleep(0.5)
                turn = data["turn_id"]
                await send("input_start", turn_id=turn)
                n = 0
                for offset in range(0, len(pcm), 640):
                    await ws.send(pcm[offset:offset + 640].ljust(640, b"\0"))
                    n += 1
                    await asyncio.sleep(0.02)
                await send("input_end", turn_id=turn, samples=n * 320, frames=n, reason="silence")
                input_done = True
                event("input_end", turn=turn)
            elif kind == "transcript":
                event("transcript", speaker=data.get("speaker"), text=data.get("text"))
            elif kind == "ping":
                await send("pong", turn_id=data.get("turn_id", 0), seq=data.get("seq", 0))
            elif kind in {"listen", "end", "call_end", "error", "no_reply"}:
                event(kind, code=data.get("code"))
                if answered and kind in {"listen", "end", "call_end"}:
                    await send("end")
                    return
                raise RuntimeError("relay ended without a voiced reply")
        raise RuntimeError("connection closed before call completion")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="wss://monban-api.shionkk.f5.si/api/relay")
    url = parser.parse_args().url
    if urlsplit(url).scheme != "wss" and url not in {
        "ws://127.0.0.1:18143/api/relay", "ws://127.0.0.1:8093/api/relay",
    }:
        parser.error("use a secure WebSocket or the local benchmark listener")
    key = os.environ.get("DOOR_API_KEY") or getpass.getpass("Relay API key: ")

    async def run():
        async with asyncio.timeout(150):
            await measure(url, key)

    asyncio.run(run())
