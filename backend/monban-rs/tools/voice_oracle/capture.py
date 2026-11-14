"""Record what the Python v2 voice pipeline (relay/agent.py DeviceAgent) does, as the oracle
for the Rust port (Issue #79).

Each scenario runs the real DeviceAgent against a scripted, recording stand-in for ASR, the
LLM, TTS and the Supabase device API. The fixture keeps every upstream request (normalized)
and every output event (audio per reply, transcripts, end-of-call decision), so the Rust
pipeline can be run against the same script and compared.

Run from backend/voice-agent:

    DOOR_API_KEY=$(python3 -c "print('k'*40)") \
      /path/to/backend/voice-agent/.venv/bin/python ../monban-rs/tools/voice_oracle/capture.py

Scenarios with ``with_turn_hook`` also call ``Agent.on_user_turn_completed`` before each
reply, as the RTC worker does. That is the behavior the Rust port adopts (Issue #79); the
as-is fixtures document the current v2 behavior, where the hook is never called.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import struct
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent.parent / "crates" / "monban-backend" / "tests" / "fixtures" / "voice"
PORT = int(os.environ.get("ORACLE_PORT", "18731"))
BASE = f"http://127.0.0.1:{PORT}"
TZ = ZoneInfo("Asia/Tokyo")

# Settings are read at import time; point every upstream at the recorder first.
os.environ.update(
    {
        "DOOR_ASR_BASE_URL": BASE,
        "DOOR_TTS_BASE_URL": BASE,
        "DOOR_OLLAMA_BASE_URL": BASE,
        "DOOR_SUPABASE_URL": BASE,
        "DOOR_SUPABASE_ANON_KEY": "sb_publishable_oracle",
        "DOOR_LLM_API_KEY": "llm-key",
        "DOOR_ASR_API_KEY": "asr-key",
        "DOOR_TTS_API_KEY": "tts-key",
        "DOOR_LLM_MODEL": "monban-oracle-llm",
        "DOOR_WARMUP": "0",
    }
)
os.environ.setdefault("DOOR_TTS_SAMPLE_RATE", "16000")
sys.path.insert(0, os.getcwd())

# Fixtures must not depend on a developer's .env (find_dotenv walks up to the repository).
import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *args, **kwargs: False

from aiohttp import web  # noqa: E402

from monban_backend.config import settings  # noqa: E402
from monban_backend.core.house_rules import HouseSettings, build_house_rules  # noqa: E402
from monban_backend.persistence.device_api import ShopProfile  # noqa: E402
from monban_backend.relay import agent as relay_agent  # noqa: E402
from livekit.agents import StopResponse  # noqa: E402
from livekit.agents import llm as lk_llm  # noqa: E402


def tts_pcm(text: str, rate: int) -> bytes:
    """Deterministic speech stand-in: a tone per character with a short gap after 。"""
    out = bytearray()
    for index, char in enumerate(text):
        samples = rate * 40 // 1000
        amplitude = 0 if char in "。！？" else 3000 + 50 * (index % 7)
        out += b"".join(
            struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 300 * i / rate)))
            for i in range(samples)
        )
    return bytes(out)


class Recorder:
    def __init__(self, scenario: dict) -> None:
        self.scenario = scenario
        self.requests: list[dict] = []
        self.asr = iter(scenario.get("asr", []))
        self.llm = iter(scenario.get("llm", []))

    def today(self) -> datetime:
        return datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)

    def reservations(self) -> list[dict]:
        day = self.today()
        rows = []
        for row in self.scenario.get("reservations", []):
            hour, minute = (int(x) for x in row["time"].split(":"))
            start = day + timedelta(hours=hour, minutes=minute)
            rows.append(
                {
                    "id": row["id"],
                    "customer_name": row["name"],
                    "service_name": row.get("service"),
                    "starts_at": start.isoformat(),
                    "ends_at": (start + timedelta(hours=1)).isoformat(),
                    "status": row.get("status", "confirmed"),
                    "arrived_at": row.get("arrived_at"),
                }
            )
        return rows

    def record(self, request: web.Request, body) -> None:
        query = dict(request.query)
        for key in ("from", "to"):
            if key in query:
                query[key] = "<date>" + query[key][10:]
        self.requests.append(
            {
                "method": request.method,
                "path": request.path,
                "query": query,
                "authorization": request.headers.get("Authorization"),
                "apikey": request.headers.get("apikey"),
                "content_type": request.content_type,
                "body": body,
            }
        )

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/v1/audio/transcriptions", self.transcriptions)
        app.router.add_post("/v1/chat/completions", self.chat)
        app.router.add_post("/v1/audio/speech", self.speech)
        app.router.add_get("/functions/v1/device/reservations", self.list_reservations)
        app.router.add_post("/functions/v1/device/reservations/{id}/arrive", self.arrive)
        return app

    async def transcriptions(self, request: web.Request) -> web.Response:
        form = await request.post()
        fields = {}
        for key, value in form.items():
            if hasattr(value, "file"):
                data = value.file.read()
                fields[key] = {
                    "filename": value.filename,
                    "content_type": value.content_type,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            else:
                fields[key] = value
        self.record(request, fields)
        return web.json_response({"text": next(self.asr)})

    async def chat(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.record(request, body)
        step = next(self.llm)
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)

        async def chunk(delta: dict, finish: str | None = None) -> None:
            data = {
                "id": "chatcmpl-oracle",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": body.get("model"),
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            await response.write(f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode())

        if "tool_calls" in step:
            for index, call in enumerate(step["tool_calls"]):
                args = json.dumps(call["arguments"], ensure_ascii=False)
                await chunk({"role": "assistant", "tool_calls": [{"index": index, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": ""}}]})
                await chunk({"tool_calls": [{"index": index, "function": {"arguments": args}}]})
            await chunk({}, "tool_calls")
        else:
            text = step["text"]
            first = True
            for piece in [text[i : i + 5] for i in range(0, len(text), 5)]:
                await chunk({"role": "assistant", "content": piece} if first else {"content": piece})
                first = False
            await chunk({}, "stop")
        await response.write(b"data: [DONE]\n\n")
        await response.write_eof()
        return response

    async def speech(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.record(request, body)
        pcm = tts_pcm(body["input"], settings.tts_sample_rate)
        if self.scenario.get("tts_format") == "sse":
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            for offset in range(0, len(pcm), 3200):
                event = {"type": "speech.audio.delta", "delta": base64.b64encode(pcm[offset : offset + 3200]).decode()}
                await response.write(f"data: {json.dumps(event)}\n\n".encode())
            await response.write(b'data: {"type": "speech.audio.done"}\n\n')
            await response.write_eof()
            return response
        return web.Response(body=pcm, content_type="audio/pcm")

    async def list_reservations(self, request: web.Request) -> web.Response:
        self.record(request, None)
        return web.json_response({"reservations": self.reservations()})

    async def arrive(self, request: web.Request) -> web.Response:
        self.record(request, None)
        reservation_id = request.match_info["id"]
        for row in self.reservations():
            if row["id"] == reservation_id:
                row["arrived_at"] = datetime.now(TZ).isoformat()
                return web.json_response({"reservation": row})
        return web.json_response({"error": "not found"}, status=404)


def normalize(value):
    """Replace per-run identifiers so fixtures are stable."""
    text = json.dumps(value, ensure_ascii=False)
    import re

    text = re.sub(r"monban-prefetch-[0-9a-f]{32}", "monban-prefetch-<id>", text)
    return json.loads(text)


async def run(name: str, scenario: dict) -> dict:
    recorder = Recorder(scenario)
    runner = web.AppRunner(recorder.app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()
    events: list[dict] = []
    pcm = bytearray()
    agent: relay_agent.DeviceAgent | None = None

    async def write(chunk: bytes) -> None:
        pcm.extend(chunk)
        events.append({"type": "audio_frame", "bytes": len(chunk)})

    async def finish() -> None:
        # The relay computes output_end.end_call at this moment (relay/v2.py finish_audio).
        events.append({"type": "finish", "end_after_reply": agent.end_after_reply()})
        asyncio.get_running_loop().call_soon(agent.played)

    async def transcript(speaker: str, text: str) -> None:
        events.append({"type": "transcript", "speaker": speaker, "text": text})

    if scenario.get("fix_raw_tools"):
        fix_raw_tools()
    shop = ShopProfile.from_json(scenario["shop"]) if scenario.get("shop") else None
    device_key = "device-oracle" if shop else None
    rules = build_house_rules(scenario.get("mode", "normal"), HouseSettings(**scenario.get("house", {})), settings.max_house_rules_chars)
    agent = relay_agent.DeviceAgent(rules, write, finish, transcript, device_key=device_key, shop=shop)
    outputs: list[dict] = []
    try:
        await agent.start()
        turns = [None] + [b"\x01\x00" * 320 * n for n in scenario.get("utterance_frames", [])]
        for index, utterance in enumerate(turns):
            events.clear()
            pcm.clear()
            text = None
            if utterance is not None:
                text = await agent.recognize(utterance)
            stopped = False
            if text is not None and scenario.get("with_turn_hook"):
                stopped = await turn_hook(agent, text)
            if text is None or (text and not stopped):
                await agent.reply(text)
            outputs.append(
                {
                    "turn": index,
                    "recognized": text,
                    "events": compact(events),
                    "pcm_samples": len(pcm) // 2,
                    "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
                    "pcm_base64": base64.b64encode(pcm).decode() if scenario.get("keep_pcm") else None,
                    "end_after_reply": agent.end_after_reply(),
                    "staff_requested": agent.staff_requested(),
                }
            )
    finally:
        await agent.aclose()
        await runner.cleanup()
    return normalize(
        {
            "name": name,
            "scenario": scenario,
            "settings": {
                "tts_sample_rate": settings.tts_sample_rate,
                "llm_model": settings.llm_model,
                "llm_max_tokens": settings.llm_max_tokens,
                "llm_keep_alive": settings.llm_keep_alive,
            },
            "house_rules": rules,
            "requests": recorder.requests,
            "turns": outputs,
        }
    )


_ORIGINAL_TOOLS: dict = {}


def fix_raw_tools() -> None:
    """Make the raw-schema tools accept ``raw_arguments`` as livekit-agents passes them.

    The current ReceptionAgent declares ``(customer_name, time)`` parameters, so every
    model-initiated call fails with "Error parsing arguments". This shim is the intended
    behavior the Rust port implements.
    """
    from monban_backend.voice import agent as voice_agent
    from monban_backend.reception.tool_schema_v17 import TOOL_SCHEMAS_V17

    cls = voice_agent.ReceptionAgent
    for name in ("search_reservations", "check_in", "notify_staff", "request_staff"):
        tool = _ORIGINAL_TOOLS.setdefault(name, cls.__dict__[name])
        plain = tool.__wrapped__
        # The agent's own direct calls (prefetch, handoffs) keep the plain method.
        setattr(cls, name, plain)

        def make(plain=plain):
            async def model_tool(self, raw_arguments: dict) -> str:
                return await plain(self, **raw_arguments)
            return model_tool

        setattr(cls, f"_model_tool_{name}", lk_llm.function_tool(raw_schema=TOOL_SCHEMAS_V17[name])(make()))


async def turn_hook(agent: relay_agent.DeviceAgent, text: str) -> bool:
    """What the RTC worker does before replying: let the agent see the finished user turn."""
    chat_ctx = agent.session.history.copy()
    message = lk_llm.ChatMessage(role="user", content=[text])
    try:
        await agent.agent.on_user_turn_completed(chat_ctx, message)
    except StopResponse:
        return True
    return False


def compact(events: list[dict]) -> list[dict]:
    """Merge consecutive audio frames into one entry with a frame count."""
    out: list[dict] = []
    for event in events:
        if event["type"] == "audio_frame" and out and out[-1]["type"] == "audio":
            out[-1]["frames"] += 1
            out[-1]["bytes"] += event["bytes"]
        elif event["type"] == "audio_frame":
            out.append({"type": "audio", "frames": 1, "bytes": event["bytes"]})
        else:
            out.append(event)
    return out


SHOP = {
    "name": "ネイルサロン架空",
    "greeting": "いらっしゃいませ、ネイルサロン架空です。",
    "business_hours": [{"day": d, "open": "10:00", "close": "19:00"} for d in range(1, 7)] + [{"day": 0, "closed": True}],
    "services": [],
}

SCENARIOS = {
    "door_delivery": {
        "mode": "normal",
        "asr": ["ヤマト運輸です。お荷物のお届けです。", "わかりました。置いておきます。"],
        "llm": [{"text": "承知しました。よろしくお願いいたします。"}, {"text": "ありがとうございます。失礼いたします。"}],
        "utterance_frames": [40, 25],
    },
    "door_llm_reply_sse": {
        "mode": "away",
        "house": {"away_leave_at_door": True, "extra_instructions": "置き配は宅配ボックスへ。"},
        "tts_format": "sse",
        "asr": ["町内会の回覧板を持ってきました。", "はい、わかりました。"],
        "llm": [{"text": "ありがとうございます。ポストに入れていただけますか。"}, {"text": "ありがとうございます。失礼いたします。"}],
        "utterance_frames": [30, 20],
        "keep_pcm": True,
    },
    "door_llm_inspection": {
        "mode": "normal",
        "with_turn_hook": True,
        "asr": ["ガスの点検に来ました。", "では、また改めてご連絡します。"],
        "llm": [{"text": "恐れ入りますが、改めてご連絡いただけますか。"}, {"text": "承知しました。失礼いたします。"}],
        "utterance_frames": [30, 20],
    },
    "door_closing_delivery": {
        "mode": "normal",
        "with_turn_hook": True,
        "asr": ["佐川急便です。お荷物です。", "はい、置いておきます。", "ありがとうございました。"],
        "llm": [{"text": "失礼いたします。"}, {"text": "失礼いたします。"}, {"text": "失礼いたします。"}],
        "utterance_frames": [20, 20, 20],
    },
    "door_llm_question_sse": {
        "mode": "normal",
        "with_turn_hook": True,
        "tts_format": "sse",
        "keep_pcm": True,
        "asr": ["すみません、道をお尋ねしたいのですが。"],
        "llm": [{"text": "申し訳ありません、こちらではご案内できません。失礼いたします。"}],
        "utterance_frames": [30],
    },
    "door_wait_hook": {
        "mode": "normal",
        "with_turn_hook": True,
        "asr": ["えっと", "佐川急便です。"],
        "llm": [{"text": "はい。"}, {"text": "恐れ入りますが、玄関の前に置いていただけますか。"}],
        "utterance_frames": [10, 20],
    },
    "shop_checkin_as_is": {
        "shop": SHOP,
        "asr": ["予約している山田太郎です。15時からです。"],
        "llm": [
            {"tool_calls": [{"id": "call_1", "name": "search_reservations", "arguments": {"customer_name": "山田太郎", "time": "15:00"}}]},
            {"text": "確認いたします。"},
        ],
        "reservations": [{"id": "r1", "name": "山田太郎", "time": "15:00", "service": "ジェルネイル"}],
        "utterance_frames": [50],
    },
    "shop_checkin_with_hook": {
        "shop": SHOP,
        "with_turn_hook": True,
        "fix_raw_tools": True,
        "asr": ["予約している山田太郎です。15時からです。", "これで大丈夫ですか。"],
        "llm": [
            {"tool_calls": [{"id": "call_2", "name": "check_in", "arguments": {"reservation_id": "r1"}}]},
            {"text": "ご来店受付を済ませました。"},
            {"text": "はい、大丈夫です。"},
        ],
        "reservations": [{"id": "r1", "name": "山田太郎", "time": "15:00", "service": "ジェルネイル"}],
        "utterance_frames": [50, 15],
    },
    "shop_staff_hook": {
        "shop": SHOP,
        "with_turn_hook": True,
        "fix_raw_tools": True,
        "asr": ["スタッフの方に確認してほしいことがあります。"],
        "llm": [
            {"tool_calls": [{"id": "call_3", "name": "request_staff", "arguments": {"reason": "その他スタッフ確認"}}]},
            {"text": "担当者に確認します。"},
        ],
        "utterance_frames": [30],
    },
}


async def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    selected = sys.argv[1:] or list(SCENARIOS)
    for name in selected:
        result = await run(name, SCENARIOS[name])
        path = FIXTURES / f"{name}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        llm_calls = sum(1 for r in result["requests"] if r["path"] == "/v1/chat/completions")
        print(f"{name}: requests={len(result['requests'])} llm_calls={llm_calls} turns={[(t['recognized'], [e for e in t['events'] if e['type']=='transcript']) for t in result['turns']]}")


if __name__ == "__main__":
    asyncio.run(main())
