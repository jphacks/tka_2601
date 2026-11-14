"""The backend's real relay code with its speech models replaced, for host tests."""
import asyncio
import os
from pathlib import Path
import socket
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("DOOR_API_KEY", "a" * 64)
os.environ.setdefault("DOOR_WARMUP", "0")
sys.path.insert(0, str(ROOT / "backend/voice-agent"))

import uvicorn  # noqa: E402
from monban_backend import api  # noqa: E402
from monban_backend.relay import v2 as relay_v2  # noqa: E402

FRAME = b"\x10\x27" * 320


class Agent:
    """Same interface as relay_v2.DeviceAgent, speaking scripted PCM."""
    instances = []
    greeting_frames = 120
    reply_frames = 60

    def __init__(self, rules, write, finish, transcript, **_kwargs):
        self.write, self.finish, self.transcript = write, finish, transcript
        self.recognized = []
        self.played_event = asyncio.Event()
        self.ended = False
        self.closed = False
        Agent.instances.append(self)

    async def start(self):
        pass

    async def recognize(self, pcm):
        self.recognized.append(pcm)
        await self.transcript("visitor", "宅配便です。")
        return "宅配便です。"

    async def reply(self, text):
        self.played_event.clear()
        frames = self.greeting_frames if text is None else self.reply_frames
        await self.transcript("ai", "はい、どちら様でしょうか。" if text is None else "玄関の前に置いていただけますか。失礼いたします。")
        for _ in range(frames):
            await self.write(FRAME)
        await self.write(b"\x10\x27" * 100)  # a short final frame
        if text is not None:
            self.ended = True
        await self.finish()
        await self.played_event.wait()

    def played(self):
        self.played_event.set()

    def end_after_reply(self):
        return self.ended

    def staff_requested(self):
        return False

    async def aclose(self):
        self.closed = True


class Backend:
    def __enter__(self):
        Agent.instances = []
        self.visits = []
        self.saved = (relay_v2.DeviceAgent, relay_v2.fetch_device_settings, relay_v2.write_visit)
        relay_v2.DeviceAgent = Agent

        async def house(_key):
            return None

        async def write_visit(*args, **kwargs):
            self.visits.append((args, kwargs))
        relay_v2.fetch_device_settings = house
        relay_v2.write_visit = write_visit
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="off"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)
        return self

    def __exit__(self, *_):
        self.server.should_exit = True
        self.thread.join(timeout=5)
        relay_v2.DeviceAgent, relay_v2.fetch_device_settings, relay_v2.write_visit = self.saved
