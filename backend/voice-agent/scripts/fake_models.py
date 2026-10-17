"""Stand-in ASR, LLM and TTS servers for running the agent and relay without labpc's models.

    uv run python -m scripts.fake_models --port 18100

Point the agent at it with DOOR_ASR_BASE_URL, DOOR_TTS_BASE_URL and DOOR_OLLAMA_BASE_URL set to
http://127.0.0.1:18100. ASR returns the --transcript texts in turn, the LLM answers with fixed
replies, and TTS returns a tone whose length follows the text. It checks the plumbing (relay,
LiveKit, agent), not the conversation quality.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import struct
import time

from aiohttp import web

from door_backend.config import settings

DEFAULT_TRANSCRIPTS = ["ヤマト運輸です。お荷物のお届けです。", "わかりました。失礼します。"]


def reply_for(messages: list[dict]) -> str:
    users = [m.get("content") for m in messages if m.get("role") == "user"]
    last = users[-1] if users and isinstance(users[-1], str) else ""
    if not last:
        return "はい、どちら様でしょうか。"
    if "荷物" in last:
        return "恐れ入りますが、玄関の前に置いていただけますか。"
    return "承知しました、失礼いたします。"


def tone(seconds: float, rate: int) -> bytes:
    samples = int(seconds * rate)
    return b"".join(
        struct.pack("<h", int(6000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(samples)
    )


def build_app(transcripts: list[str]) -> web.Application:
    texts = itertools.cycle(transcripts)

    async def models(_request):
        return web.json_response(
            {
                "data": [
                    {"id": settings.asr_model},
                    {"id": settings.tts_model, "speech": {"voices": [{"name": settings.tts_voice}]}},
                ]
            }
        )

    async def tags(_request):
        return web.json_response({"models": [{"name": settings.llm_model}]})

    async def transcriptions(request):
        await request.post()
        return web.json_response({"text": next(texts)})

    async def chat(request):
        body = await request.json()
        text = reply_for(body.get("messages", []))
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)

        def chunk(delta: dict, finish: str | None = None) -> bytes:
            data = {
                "id": "fake",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": body.get("model", settings.llm_model),
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode()

        await response.write(chunk({"role": "assistant", "content": text}))
        await response.write(chunk({}, "stop"))
        await response.write(b"data: [DONE]\n\n")
        await response.write_eof()
        return response

    async def speech(request):
        body = await request.json()
        pcm = tone(0.15 * len(body.get("input", "")), settings.tts_sample_rate)
        return web.Response(body=pcm, content_type="audio/pcm")

    app = web.Application()
    app.router.add_get("/v1/models", models)
    app.router.add_get("/api/tags", tags)
    app.router.add_post("/v1/audio/transcriptions", transcriptions)
    app.router.add_post("/v1/chat/completions", chat)
    app.router.add_post("/v1/audio/speech", speech)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=18100)
    parser.add_argument("--transcript", action="append", help="ASR が順に返す文（複数指定可）")
    args = parser.parse_args()
    web.run_app(build_app(args.transcript or DEFAULT_TRANSCRIPTS), host="127.0.0.1", port=args.port)
