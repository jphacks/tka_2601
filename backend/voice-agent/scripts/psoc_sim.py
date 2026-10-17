"""Talk to /api/relay the way the PSoC 6 does, using WAV files instead of the microphone.

    uv run python scripts/psoc_sim.py --url ws://127.0.0.1:8093/api/relay visitor1.wav visitor2.wav

The WAV files must be 16 kHz, 16-bit, mono. Each one is sent after the agent finishes speaking.
Like the PSoC 6 (spec.md 3.7, 5.1), microphone audio (the WAV or silence) is sent every 20 ms,
except while the agent's voice is playing and for 0.5 s after it. The agent's voice is saved to
--out. DOOR_API_KEY is read from the environment or .env; DOOR_DEVICE_KEY is the device key used
to read the house settings (a dummy key means no settings).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
import wave
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

SAMPLE_RATE = 16000
FRAME_BYTES = SAMPLE_RATE * 20 // 1000 * 2
FRAME_SECONDS = 0.02
MUTE_AFTER_PLAYBACK = 0.5
IDLE_BEFORE_SPEAKING = 1.0


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        if (wav.getframerate(), wav.getsampwidth(), wav.getnchannels()) != (SAMPLE_RATE, 2, 1):
            sys.exit(
                f"{path}: 16 kHz・16bit・モノラルの WAV にしてください"
                f"（例: afconvert -f WAVE -d LEI16@16000 -c 1 in.aiff {path.name}）"
            )
        return wav.readframes(wav.getnframes())


class Simulator:
    def __init__(self, utterances: list[bytes], time_limit: float) -> None:
        self.utterances = utterances
        self.time_limit = time_limit
        self.started = time.monotonic()
        self.playback_until = 0.0
        self.last_audio_at = 0.0
        self.agent_spoke = False
        self.closing = False
        self.reply_wait_from: float | None = None
        self.received = bytearray()
        self.audio_messages = 0
        self.odd_sized_messages = 0
        self.transcripts: list[dict] = []

    def log(self, text: str) -> None:
        print(f"[{time.monotonic() - self.started:6.2f}s] {text}", flush=True)

    @property
    def muted(self) -> bool:
        return time.monotonic() < self.playback_until + MUTE_AFTER_PLAYBACK

    def on_audio(self, pcm: bytes) -> None:
        now = time.monotonic()
        if self.reply_wait_from is not None:
            self.log(f"返答の音まで {now - self.reply_wait_from:.2f} 秒（訪問者の発話の送信終了から）")
            self.reply_wait_from = None
        self.playback_until = max(now, self.playback_until) + len(pcm) / 2 / SAMPLE_RATE
        self.last_audio_at = now
        self.agent_spoke = True
        self.received.extend(pcm)
        self.audio_messages += 1
        self.odd_sized_messages += len(pcm) != FRAME_BYTES

    def on_json(self, message: dict) -> None:
        self.log(json.dumps(message, ensure_ascii=False))
        if message.get("type") == "transcript":
            self.transcripts.append(message)
            if message.get("speaker") == "ai" and "失礼いたします" in message.get("text", ""):
                self.closing = True

    def ready_to_speak(self) -> bool:
        idle = time.monotonic() - self.last_audio_at >= IDLE_BEFORE_SPEAKING
        return self.agent_spoke and idle and not self.muted

    async def receive(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.BINARY:
                self.on_audio(message.data)
            elif message.type == aiohttp.WSMsgType.TEXT:
                self.on_json(json.loads(message.data))

    async def send(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        pending = list(self.utterances)
        current = b""
        next_tick = time.monotonic()
        while time.monotonic() - self.started < self.time_limit:
            next_tick += FRAME_SECONDS
            await asyncio.sleep(max(0.0, next_tick - time.monotonic()))
            if self.muted:
                continue
            if not current and self.ready_to_speak():
                # Like the PSoC 6, hang up once the agent has said goodbye (spec.md 5.1 CLOSING).
                if self.closing or not pending:
                    break
                current = pending.pop(0)
                self.agent_spoke = False
                self.log(f"訪問者の発話を送る（{len(current) / 2 / SAMPLE_RATE:.1f} 秒）")
            if current:
                frame, current = current[:FRAME_BYTES], current[FRAME_BYTES:]
                frame = frame.ljust(FRAME_BYTES, b"\x00")
                if not current:
                    self.reply_wait_from = time.monotonic()
            else:
                frame = bytes(FRAME_BYTES)
            await ws.send_bytes(frame)
        self.log("終了を送る")
        await ws.send_json({"type": "end"})


async def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wav", nargs="*", type=Path, help="訪問者の発話（16 kHz・16bit・モノラル）")
    parser.add_argument("--url", default="ws://127.0.0.1:8093/api/relay")
    parser.add_argument("--mode", default="omakase", choices=["normal", "omakase", "away"])
    parser.add_argument("--out", type=Path, default=Path("agent_reply.wav"))
    parser.add_argument("--time-limit", type=float, default=50.0, help="通話の上限（秒）")
    args = parser.parse_args()

    api_key = os.getenv("DOOR_API_KEY")
    if not api_key:
        sys.exit("DOOR_API_KEY を環境変数か .env に設定してください")
    simulator = Simulator([read_pcm(path) for path in args.wav], args.time_limit)
    start = {
        "type": "start",
        "visit_id": str(uuid.uuid4()),
        "mode": args.mode,
        "device_key": os.getenv("DOOR_DEVICE_KEY") or "dummy-device-key",
    }
    async with aiohttp.ClientSession() as http:
        connect_started = time.monotonic()
        async with http.ws_connect(args.url, headers={"Authorization": f"Bearer {api_key}"}) as ws:
            await ws.send_json(start)
            first = await ws.receive(timeout=10)
            if first.type != aiohttp.WSMsgType.TEXT or json.loads(first.data) != {"type": "ready"}:
                sys.exit(f"ready が届きません: {first.type} {first.data}")
            simulator.log(f"ready（接続から {time.monotonic() - connect_started:.2f} 秒、目標は 2 秒以内）")
            receiver = asyncio.create_task(simulator.receive(ws))
            await simulator.send(ws)
            await asyncio.wait_for(receiver, timeout=5)
            simulator.log(f"切断 code={ws.close_code}")

    with wave.open(str(args.out), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(bytes(simulator.received))
    print(f"\nエージェントの声: {args.out}（{len(simulator.received) / 2 / SAMPLE_RATE:.1f} 秒）")
    print(f"音のメッセージ: {simulator.audio_messages} 通（{FRAME_BYTES} B 以外: {simulator.odd_sized_messages} 通）")
    for item in simulator.transcripts:
        print(f"{item['speaker']:>7}: {item['text']}")


if __name__ == "__main__":
    asyncio.run(main())
