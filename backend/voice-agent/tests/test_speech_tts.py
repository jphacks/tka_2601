import asyncio
import base64
import json

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
