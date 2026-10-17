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


class SentenceSession:
    batches = []

    def __init__(self, **_kwargs):
        self.requests = []

    def post(self, *_args, **kwargs):
        self.requests.append(kwargs["json"])
        return Response(self.batches.pop(0))

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


def direct_stream(tts, input_text):
    """Build a stream without ChunkedStream's background synthesis task."""
    stream = object.__new__(speech_tts.SpeechCppStream)
    stream._tts = tts
    stream._input_text = input_text
    stream._conn_options = DEFAULT_API_CONNECT_OPTIONS
    return stream


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
        stream = direct_stream(tts, "失礼いたします。")
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


def test_keep_two_sentences_after_a_long_pause():
    first = [5000] * (24000 // 2)
    silence = [0] * (24000 * 14 // 10)
    second = [4200] * (24000 * 3 // 4)
    samples = first + silence + second
    pcm = struct.pack(f"<{len(samples)}h", *samples)
    text = "恐れ入りますが、こちらでお願いいたします。ご不明でしたらお知らせください。"

    assert speech_tts._trim_delayed_audio_tail(pcm, 24000, text) == pcm


def test_split_sentences_keeps_punctuation_and_closing_quote():
    assert speech_tts._split_sentences('「はい、大丈夫です。」次の文です！') == [
        '「はい、大丈夫です。」',
        "次の文です！",
    ]


def test_multi_sentence_speech_is_trimmed_per_sentence():
    sample_rate = 48000
    speech = [5000] * (sample_rate // 2)
    silence = [0] * (sample_rate * 14 // 10)
    delayed_tail = [5000] * (sample_rate // 5)
    samples = speech + silence + delayed_tail
    pcm = struct.pack(f"<{len(samples)}h", *samples)
    delta = base64.b64encode(pcm).decode()
    event_batch = [
        {"type": "speech.audio.delta", "delta": delta},
        {"type": "speech.audio.done"},
    ]
    SentenceSession.batches = [event_batch.copy(), event_batch.copy()]

    async def synthesize():
        tts = speech_tts.SpeechCppTTS()
        tts._http = SentenceSession()
        stream = direct_stream(tts, "玄関前に置いてください。写真を撮ってください。")
        emitter = Emitter()
        await stream._run(emitter)
        return tts._http, emitter

    session, emitter = asyncio.run(synthesize())

    assert [request["input"] for request in session.requests] == [
        "玄関前に置いてください。",
        "写真を撮ってください。",
    ]
    frame_bytes = (sample_rate // 50) * 2
    expected_sentence_frames = len(speech) // (sample_rate // 50) + 9
    assert len(emitter.pcm) == 1
    assert len(emitter.pcm[0]) == 2 * expected_sentence_frames * frame_bytes
    assert emitter.flushed
