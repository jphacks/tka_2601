from __future__ import annotations

import asyncio
import base64
import json
import uuid

import aiohttp
from livekit.agents import APIConnectionError, APIError, APIStatusError, APITimeoutError, tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

from .config import settings


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
                            output_emitter.push(pcm)
                        elif kind in {"error", "speech.audio.error"}:
                            raise APIError("Local speech synthesis failed")
                        elif kind == "speech.audio.done":
                            completed = True
                            break
                    if not completed:
                        raise APIError("Local speech stream ended before completion")
                elif response.content_type in {"audio/pcm", "application/octet-stream"}:
                    async for chunk in response.content.iter_chunked(8192):
                        output_emitter.push(chunk)
                else:
                    raise APIError("Local speech service returned an unsupported content type")
                output_emitter.flush()
        except asyncio.TimeoutError as exc:
            raise APITimeoutError() from exc
        except aiohttp.ClientError as exc:
            raise APIConnectionError(str(exc)) from exc
