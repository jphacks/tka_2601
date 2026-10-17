from __future__ import annotations

import asyncio
import base64
import json
import math
import struct
import uuid

import aiohttp
from livekit.agents import APIConnectionError, APIError, APIStatusError, APITimeoutError, tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

from .config import settings


def _trim_delayed_audio_tail(pcm: bytes, sample_rate: int) -> bytes:
    """Remove a late vocal tail when the TTS stream pauses for a long time."""
    frame_samples = max(1, sample_rate // 50)  # 20 ms
    frame_bytes = frame_samples * 2
    complete_bytes = len(pcm) - len(pcm) % frame_bytes
    if complete_bytes < frame_bytes * 4:
        return pcm

    levels: list[float] = []
    for offset in range(0, complete_bytes, frame_bytes):
        samples = struct.unpack_from(f"<{frame_samples}h", pcm, offset)
        levels.append(math.sqrt(sum(sample * sample for sample in samples) / frame_samples))
    peak = max(levels, default=0.0)
    threshold = max(32.0, peak * 0.006)
    active = [level >= threshold for level in levels]
    silence_frames = int(1.5 * sample_rate / frame_samples)
    last_active = max((index for index, is_active in enumerate(active) if is_active), default=-1)

    index = 0
    while index < last_active:
        if active[index]:
            index += 1
            continue
        gap_start = index
        while index <= last_active and not active[index]:
            index += 1
        if index - gap_start >= silence_frames:
            # Keep a short natural decay after the completed phrase, and drop
            # audio that resumes after the long pause (usually a stray vowel).
            keep_frames = int(0.18 * sample_rate / frame_samples)
            cutoff = min(complete_bytes, (gap_start + keep_frames) * frame_bytes)
            return pcm[:cutoff - cutoff % 2]
    return pcm


class SpeechCppTTS(tts.TTS):
    def __init__(self) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=settings.tts_sample_rate,
            num_channels=1,
        )
        self._http: aiohttp.ClientSession | None = None

    @property
    def model(self) -> str:
        return settings.tts_model

    @property
    def provider(self) -> str:
        return "speech.cpp-local"

    def synthesize(self, text: str, *, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        return SpeechCppStream(tts=self, input_text=text, conn_options=conn_options)

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.close()
            self._http = None


class SpeechCppStream(tts.ChunkedStream):
    async def _run(self, output_emitter) -> None:
        owner: SpeechCppTTS = self._tts
        if owner._http is None:
            owner._http = aiohttp.ClientSession(read_bufsize=4 * 1024 * 1024)
        body = {
            "model": settings.tts_model,
            "input": self.input_text,
            "voice": settings.tts_voice,
            "language": "ja",
            "seed": settings.tts_seed,
            "response_format": "pcm",
            "stream_format": "sse",
        }
        if settings.tts_instructions:
            body["instructions"] = settings.tts_instructions
        timeout = aiohttp.ClientTimeout(total=45, connect=self._conn_options.timeout, sock_read=30)
        initialized = False
        try:
            async with owner._http.post(
                f"{settings.tts_base_url}/v1/audio/speech", json=body, timeout=timeout
            ) as response:
                if response.status != 200:
                    raise APIStatusError(
                        "Local speech service returned an error", status_code=response.status
                    )
                output_emitter.initialize(
                    request_id=response.headers.get("x-request-id", uuid.uuid4().hex),
                    sample_rate=settings.tts_sample_rate,
                    num_channels=1,
                    mime_type="audio/pcm",
                    frame_size_ms=20,
                )
                initialized = True
                audio_parts: list[bytes] = []
                if response.content_type == "text/event-stream":
                    completed = False
                    async for raw in response.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            completed = True
                            break
                        event = json.loads(data)
                        kind = event.get("type")
                        if kind == "speech.audio.delta":
                            pcm = base64.b64decode(event.get("delta") or event.get("audio") or "", validate=True)
                            if len(pcm) % 2:
                                raise APIError("Local speech service returned an incomplete PCM sample")
                            audio_parts.append(pcm)
                        elif kind in {"error", "speech.audio.error"}:
                            raise APIError("Local speech synthesis failed")
                        elif kind == "speech.audio.done":
                            completed = True
                            break
                    if not completed:
                        raise APIError("Local speech stream ended before completion")
                elif response.content_type in {"audio/pcm", "application/octet-stream"}:
                    async for chunk in response.content.iter_chunked(8192):
                        audio_parts.append(chunk)
                else:
                    raise APIError("Local speech service returned an unsupported content type")
                pcm = b"".join(audio_parts)
                if pcm:
                    output_emitter.push(_trim_delayed_audio_tail(pcm, settings.tts_sample_rate))
                output_emitter.flush()
        except asyncio.TimeoutError as exc:
            raise APITimeoutError() from exc
        except aiohttp.ClientError as exc:
            raise APIConnectionError(str(exc)) from exc
