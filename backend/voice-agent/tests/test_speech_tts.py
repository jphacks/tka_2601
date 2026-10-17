import asyncio
import base64
import json
import struct

from door_backend import speech_tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS


class Content:
    def __init__(self, events):
        self.events = events

    def __aiter__(self):
        async def iterate():
            for event in self.events:
                yield f"data: {json.dumps(event)}\n\n".encode()

        return iterate()


class Response:
    status = 200
    content_type = "text/event-stream"

    def __init__(self, events):
        self.content = Content(events)
        self.headers = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class Session:
    events = []

    def __init__(self, **_kwargs):
        pass

    def post(self, *_args, **_kwargs):
        return Response(self.events)

    async def close(self):
        pass


class Emitter:
    def __init__(self):
        self.pcm = []
        self.flushed = False

    def initialize(self, **_kwargs):
        pass

    def push(self, pcm):
        self.pcm.append(pcm)

    def flush(self):
        self.flushed = True


def test_speech_audio_done_stops_later_audio_deltas(monkeypatch):
    first = base64.b64encode(b"\x01\x02").decode()
    trailing = base64.b64encode(b"\x03\x04").decode()
    Session.events = [
        {"type": "speech.audio.delta", "delta": first},
        {"type": "speech.audio.done"},
        {"type": "speech.audio.delta", "delta": trailing},
        {"type": "error"},
    ]
    monkeypatch.setattr(speech_tts.aiohttp, "ClientSession", Session)

    async def synthesize():
        tts = speech_tts.SpeechCppTTS()
        stream = speech_tts.SpeechCppStream(
            tts=tts,
            input_text="失礼いたします。",
            conn_options=DEFAULT_API_CONNECT_OPTIONS,
        )
        emitter = Emitter()
        await stream._run(emitter)
        return emitter

    emitter = asyncio.run(synthesize())
    assert emitter.pcm == [base64.b64decode(first)]
    assert emitter.flushed


def test_trim_delayed_vocal_tail_after_long_pause():
    speech_samples = [5000] * (24000 // 2)
    silence_samples = [0] * (24000 * 16 // 10)
    stray_tail_samples = [5000] * (24000 * 3 // 10)
    pcm = struct.pack(
        f"<{len(speech_samples) + len(silence_samples) + len(stray_tail_samples)}h",
        *(speech_samples + silence_samples + stray_tail_samples),
    )

    trimmed = speech_tts._trim_delayed_audio_tail(pcm, 24000)

    assert len(trimmed) < len(pcm) - len(stray_tail_samples) * 2
    assert len(trimmed) <= len(speech_samples + silence_samples) * 2


def test_keep_audio_after_normal_pause():
    first = [5000] * (24000 // 2)
    silence = [0] * (24000 // 2)
    second = [5000] * (24000 // 2)
    pcm = struct.pack(f"<{len(first + silence + second)}h", *(first + silence + second))

    assert speech_tts._trim_delayed_audio_tail(pcm, 24000) == pcm
