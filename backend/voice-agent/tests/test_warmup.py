import asyncio
import io
import wave
from dataclasses import asdict
from types import SimpleNamespace

from aiohttp import web

from door_backend import warmup


def test_silence_wav_is_16khz_mono_pcm():
    with wave.open(io.BytesIO(warmup._silence_wav())) as wav:
        assert wav.getframerate() == 16000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getnframes() == 16000 * warmup.WARMUP_SILENCE_MS // 1000


def test_warm_models_can_be_disabled(monkeypatch):
    monkeypatch.setattr(warmup, "settings", SimpleNamespace(warmup_enabled=False))
    assert asyncio.run(warmup.warm_models()) is True


def test_warm_models_probes_every_service(monkeypatch):
    seen = {}

    async def asr(request):
        seen["asr"] = await request.post()
        return web.json_response({"text": ""})

    async def llm(request):
        seen["llm"] = await request.json()
        return web.json_response({"response": ""})

    async def tts(request):
        seen["tts"] = await request.json()
        return web.Response(
            text='data: {"type":"speech.audio.done"}\n\ndata: [DONE]\n\n',
            content_type="text/event-stream",
        )

    async def main():
        app = web.Application()
        app.router.add_post("/v1/audio/transcriptions", asr)
        app.router.add_post("/api/generate", llm)
        app.router.add_post("/v1/audio/speech", tts)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        values = asdict(warmup.settings)
        values.update(
            warmup_enabled=True,
            warmup_timeout_seconds=5,
            asr_base_url=base,
            tts_base_url=base,
            ollama_base_url=base,
        )
        monkeypatch.setattr(warmup, "settings", SimpleNamespace(**values))
        try:
            return await warmup.warm_models()
        finally:
            await runner.cleanup()

    assert asyncio.run(main()) is True
    assert seen["asr"]["model"] == warmup.settings.asr_model
    assert seen["asr"]["language"] == "ja"
    assert seen["asr"]["file"].filename == "warmup.wav"
    assert seen["llm"]["model"] == warmup.settings.llm_model
    assert seen["llm"]["keep_alive"] == warmup.settings.llm_keep_alive
    assert seen["tts"]["voice"] == warmup.settings.tts_voice


def test_warm_models_reports_failure(monkeypatch):
    values = asdict(warmup.settings)
    # Nothing listens on port 1, so all three probes fail fast and warm_models returns False.
    values.update(
        warmup_enabled=True,
        warmup_timeout_seconds=2,
        asr_base_url="http://127.0.0.1:1",
        tts_base_url="http://127.0.0.1:1",
        ollama_base_url="http://127.0.0.1:1",
    )
    monkeypatch.setattr(warmup, "settings", SimpleNamespace(**values))
    assert asyncio.run(warmup.warm_models()) is False
