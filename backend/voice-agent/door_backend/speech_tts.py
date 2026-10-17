from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import struct
import uuid

import aiohttp
from livekit.agents import APIConnectionError, APIError, APIStatusError, APITimeoutError, tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

from .config import settings


def _split_sentences(text: str) -> list[str]:
    """Keep Japanese sentence boundaries so each sentence can be cleaned safely."""
    endings = "。！？!?"
    closers = "」』】）》)]}"
    sentences: list[str] = []
    start = 0
    index = 0
    while index < len(text):
        if text[index] not in endings:
            index += 1
            continue
        end = index + 1
        while end < len(text) and text[end] in endings:
            end += 1
        while end < len(text) and text[end] in closers:
            end += 1
        sentence = text[start:end].strip()
        if sentence:
            sentences.append(sentence)
        start = end
        index = end
    remainder = text[start:].strip()
    if remainder:
        sentences.append(remainder)
    return sentences


def _trim_delayed_audio_tail(pcm: bytes, sample_rate: int, text: str = "") -> bytes:
    """Cut audio that resumes after an unusually long pause near the end."""
    # The audio defect is a delayed vocal tail after a single closing sentence.
    # Never trim across a sentence boundary, even if a two-sentence reply pauses
    # longer than usual between its sentences.
    if len(re.findall(r"[。！？!?]+", text)) > 1:
        return pcm
    frame_samples = max(1, sample_rate // 50)  # 20 ms
    frame_bytes = frame_samples * 2  # mono signed 16-bit PCM
    complete_bytes = len(pcm) - len(pcm) % frame_bytes
    if complete_bytes < frame_bytes * 4:
        return pcm

    levels: list[float] = []
    for offset in range(0, complete_bytes, frame_bytes):
        samples = struct.unpack_from(f"<{frame_samples}h", pcm, offset)
        levels.append(math.sqrt(sum(sample * sample for sample in samples) / frame_samples))
    threshold = max(32.0, max(levels, default=0.0) * 0.006)
    active = [level >= threshold for level in levels]
    # The measured v4.1-Small-MF tail starts after ~1.3 s of silence. Normal
    # sentence pauses are shorter; keeping 180 ms preserves the phrase's decay.
    silence_frames = int(1.0 * sample_rate / frame_samples)
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
            keep_frames = int(0.18 * sample_rate / frame_samples)
            cutoff = min(complete_bytes, (gap_start + keep_frames) * frame_bytes)
            return pcm[: cutoff - cutoff % 2]
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
        timeout = aiohttp.ClientTimeout(total=45, connect=self._conn_options.timeout, sock_read=30)
        initialized = False
        request_id = uuid.uuid4().hex
        audio_parts: list[bytes] = []
        sentences = _split_sentences(self.input_text)
        if not sentences and self.input_text.strip():
            sentences = [self.input_text.strip()]
        try:
            for sentence in sentences:
                body = {
                    "model": settings.tts_model,
                    "input": sentence,
                    "voice": settings.tts_voice,
                    "language": "ja",
                    "seed": settings.tts_seed,
                    "response_format": "pcm",
                    "stream_format": "sse",
                }
                if settings.tts_instructions:
                    body["instructions"] = settings.tts_instructions

                async with owner._http.post(
                    f"{settings.tts_base_url}/v1/audio/speech", json=body, timeout=timeout
                ) as response:
                    if response.status != 200:
                        raise APIStatusError(
                            "Local speech service returned an error", status_code=response.status
                        )
                    if not initialized:
                        output_emitter.initialize(
                            request_id=response.headers.get("x-request-id", request_id),
                            sample_rate=settings.tts_sample_rate,
                            num_channels=1,
                            mime_type="audio/pcm",
                            frame_size_ms=20,
                        )
                        initialized = True
                    sentence_parts: list[bytes] = []
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
                                pcm = base64.b64decode(
                                    event.get("delta") or event.get("audio") or "", validate=True
                                )
                                if len(pcm) % 2:
                                    raise APIError(
                                        "Local speech service returned an incomplete PCM sample"
                                    )
                                sentence_parts.append(pcm)
                            elif kind in {"error", "speech.audio.error"}:
                                raise APIError("Local speech synthesis failed")
                            elif kind == "speech.audio.done":
                                completed = True
                                break
                        if not completed:
                            raise APIError("Local speech stream ended before completion")
                    elif response.content_type in {"audio/pcm", "application/octet-stream"}:
                        async for chunk in response.content.iter_chunked(8192):
                            sentence_parts.append(chunk)
                    else:
                        raise APIError("Local speech service returned an unsupported content type")

                pcm = b"".join(sentence_parts)
                if len(pcm) % 2:
                    raise APIError("Local speech service returned an incomplete PCM sample")
                if pcm:
                    audio_parts.append(
                        _trim_delayed_audio_tail(pcm, settings.tts_sample_rate, sentence)
                    )

            if not initialized:
                output_emitter.initialize(
                    request_id=request_id,
                    sample_rate=settings.tts_sample_rate,
                    num_channels=1,
                    mime_type="audio/pcm",
                    frame_size_ms=20,
                )
            pcm = b"".join(audio_parts)
            if pcm:
                output_emitter.push(pcm)
            output_emitter.flush()
        except asyncio.TimeoutError as exc:
            raise APITimeoutError() from exc
        except aiohttp.ClientError as exc:
            raise APIConnectionError(str(exc)) from exc
