"""Load the local models before a conversation starts.

The greeting ("はい、どちら様でしょうか") exercises the LLM and TTS, so those are warm by
the time the visitor answers. Whisper (ASR) is only used on the visitor's first utterance,
and Ollama drops an idle model after ``keep_alive``. Without a warm-up the first reply waits
for the ASR model to load and for Ollama to reload Gemma, which shows up as a long silence
after "こんにちは、宅配便です".

:func:`warm_models` runs each probe concurrently and never raises. :func:`schedule` fires it
once per process in the background so it overlaps the greeting.
"""

from __future__ import annotations

import asyncio
import io
import logging
import time
import wave

import aiohttp

from .config import settings

logger = logging.getLogger("door-warmup")

WARMUP_SAMPLE_RATE = 16000
WARMUP_SILENCE_MS = 800
WARMUP_TEXT = "はい。"


def _silence_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(WARMUP_SAMPLE_RATE)
        wav.writeframes(b"\x00\x00" * (WARMUP_SAMPLE_RATE * WARMUP_SILENCE_MS // 1000))
    return buffer.getvalue()


async def _warm_asr(http: aiohttp.ClientSession, timeout: aiohttp.ClientTimeout) -> None:
    form = aiohttp.FormData()
    form.add_field("file", _silence_wav(), filename="warmup.wav", content_type="audio/wav")
    form.add_field("model", settings.asr_model)
    form.add_field("language", "ja")
    form.add_field("response_format", "json")
    async with http.post(
        f"{settings.asr_base_url}/v1/audio/transcriptions", data=form, timeout=timeout
    ) as response:
        response.raise_for_status()
        await response.read()


async def _warm_llm(http: aiohttp.ClientSession, timeout: aiohttp.ClientTimeout) -> None:
    """Load the LLM and refresh its keep_alive via Ollama's native endpoint.

    The OpenAI-compatible endpoint used for the live calls does not always honor keep_alive,
    so pin the model here as well.
    """
    body = {
        "model": settings.llm_model,
        "prompt": "こんにちは",
        "stream": False,
        "keep_alive": settings.llm_keep_alive,
        "options": {"num_predict": 1, "temperature": 0},
    }
    async with http.post(
        f"{settings.ollama_base_url}/api/generate", json=body, timeout=timeout
    ) as response:
        response.raise_for_status()
        await response.read()


async def _warm_tts(http: aiohttp.ClientSession, timeout: aiohttp.ClientTimeout) -> None:
    body = {
        "model": settings.tts_model,
        "input": WARMUP_TEXT,
        "voice": settings.tts_voice,
        "language": "ja",
        "seed": settings.tts_seed,
        "response_format": "pcm",
        "stream_format": "sse",
    }
    if settings.tts_instructions:
        body["instructions"] = settings.tts_instructions
    async with http.post(
        f"{settings.tts_base_url}/v1/audio/speech", json=body, timeout=timeout
    ) as response:
        response.raise_for_status()
        async for _chunk in response.content.iter_chunked(8192):
            pass


async def warm_models() -> bool:
    """Probe ASR, the LLM and TTS once so their models are resident. Never raises.

    Returns True only when every probe succeeded, so the caller can retry later.
    """
    if not settings.warmup_enabled:
        return True
    timeout = aiohttp.ClientTimeout(
        total=settings.warmup_timeout_seconds, connect=5, sock_read=settings.warmup_timeout_seconds
    )
    started = time.monotonic()
    try:
        async with aiohttp.ClientSession() as http:
            results = await asyncio.gather(
                _warm_asr(http, timeout),
                _warm_llm(http, timeout),
                _warm_tts(http, timeout),
                return_exceptions=True,
            )
    except Exception as exc:  # the aiohttp session itself could not be created
        logger.warning("warm-up could not start: %s", type(exc).__name__)
        return False
    ok = True
    for name, result in zip(("asr", "llm", "tts"), results):
        if isinstance(result, BaseException):
            logger.warning("warm-up %s failed: %s", name, type(result).__name__)
            ok = False
    logger.info("model warm-up finished in %.1fs (ok=%s)", time.monotonic() - started, ok)
    return ok


_task: asyncio.Task | None = None
_warmed_ok = False


async def _run_once() -> None:
    global _warmed_ok
    _warmed_ok = await warm_models()


def schedule() -> None:
    """Start one background warm-up for this process, unless one is running or succeeded."""
    global _task
    if not settings.warmup_enabled or _warmed_ok:
        return
    if _task is not None and not _task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _task = loop.create_task(_run_once())


async def shutdown() -> None:
    """Cancel a warm-up that is still running, e.g. during a short-lived test server."""
    global _task
    task = _task
    _task = None
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
