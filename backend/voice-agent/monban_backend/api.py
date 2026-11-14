from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import secrets
import time
import wave
from contextlib import asynccontextmanager
from typing import Literal

import aiohttp
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.openapi.utils import get_openapi
from fastapi.responses import Response
from livekit import api
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import legal, relay
from .config import settings
from .core import warmup
from .core.house_rules import Mode, build_house_rules
from .core.http_limits import CapacityLimiter, RequestBodyLimitMiddleware
from .core.services import (
    dispatch_agent as _dispatch_agent,
)
from .core.services import (
    livekit_available as _livekit_available,
)
from .core.services import (
    llm_available as _llm_available,
)
from .core.services import (
    model_available as _model_available,
)
from .persistence.device_api import fetch_device_settings

logger = logging.getLogger("door-api")
PREVIEW_TEXTS = {
    "thanks": "ありがとうございます。",
    "compound": "ありがとうございます。それでは、お荷物は玄関前にお願いいたします。",
}
# Production exposes only the status check; voice uses the WSS /api/relay. The direct
# WebRTC /api/connect answers 409 there so a misconfigured client gets a clear reason.
PRODUCTION_API = {
    ("GET", "/api/status"),
    ("POST", "/api/connect"),
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=settings.log_level)
    relay.configure_event_log()
    try:
        yield
    finally:
        await warmup.shutdown()


app = FastAPI(
    title="Monban Voice Backend",
    description=(
        "Monbanの玄関・店舗受付の音声バックエンドです。"
        "アカウント、家・店舗、予約、Googleカレンダー連携、来客履歴はSupabaseが管理し、"
        "このAPIは音声会話だけを扱います。`/api/*` はAPIキーのBearer認証です。"
        "PSoC 6用のWebSocket `/api/relay` はOpenAPIには表示されません。"
    ),
    version="2.0.0",
    openapi_tags=[
        {"name": "status", "description": "サービスとモデルの準備状態"},
        {"name": "voice", "description": "開発用のWebRTC音声通話とTTS確認"},
    ],
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)



def _openapi_schema():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
        tags=app.openapi_tags,
        servers=app.servers,
        terms_of_service=app.terms_of_service,
        contact=app.contact,
        license_info=app.license_info,
    )
    schema.setdefault("components", {}).setdefault("securitySchemes", {})[
        "BearerAuth"
    ] = {"type": "http", "scheme": "bearer"}
    for path, path_item in schema["paths"].items():
        if path.startswith("/api/"):
            for operation in path_item.values():
                if isinstance(operation, dict) and "responses" in operation:
                    operation["security"] = [{"BearerAuth": []}]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = _openapi_schema
app.include_router(legal.router)
@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    """Container liveness probe; dependency readiness is reported by /api/status."""
    return {"status": "ok"}


app.add_middleware(RequestBodyLimitMiddleware, max_bytes=settings.max_api_request_bytes)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

_request_window_started = time.monotonic()
_request_window_count = 0
_api_capacity = CapacityLimiter(
    settings.max_concurrent_expensive_requests,
    settings.max_queued_requests,
    settings.queue_wait_seconds,
)


_relay_sessions = 0


def _valid_api_key(authorization: str) -> bool:
    scheme, separator, supplied_key = authorization.partition(" ")
    return bool(separator) and scheme.lower() == "bearer" and secrets.compare_digest(
        supplied_key.strip().encode("utf-8"), settings.api_key.encode("utf-8")
    )


def _take_request_slot() -> bool:
    global _request_window_started, _request_window_count
    now = time.monotonic()
    if now - _request_window_started >= 60:
        _request_window_started = now
        _request_window_count = 0
    if _request_window_count >= settings.api_requests_per_minute:
        return False
    _request_window_count += 1
    return True


@app.middleware("http")
async def protect_api(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        if settings.environment == "production" and request.url.scheme != "https" and not settings.allow_tailnet_http:
            return Response("HTTPS is required", status_code=400)
        if not _take_request_slot():
            return Response(
                "Too Many Requests",
                status_code=429,
                headers={"Retry-After": "60", "Cache-Control": "no-store"},
            )
        if settings.environment == "production" and (request.method, request.url.path) not in PRODUCTION_API:
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        if not _valid_api_key(request.headers.get("authorization", "")):
            return Response(
                "Unauthorized",
                status_code=401,
                headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"},
            )

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > settings.max_api_request_bytes:
                    return Response("Request body is too large", status_code=413)
            except ValueError:
                return Response("Invalid Content-Length", status_code=400)


    if request.url.path in {"/api/status", "/api/connect", "/api/tts-check"}:
        if not await _api_capacity.acquire():
            return Response(
                "Service is at capacity; retry shortly",
                status_code=503,
                headers={"Retry-After": "1", "Cache-Control": "no-store"},
            )
        try:
            response = await call_next(request)
        finally:
            await _api_capacity.release()
    else:
        response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"service": "monban-api", "docs": "/docs", "health": "/healthz"}


class ConnectRequest(BaseModel):
    house_rules: str | None = Field(default=None, max_length=settings.max_house_rules_chars)
    # With a device key the call uses that device's Supabase settings, as /api/relay does:
    # a shop gets the reception agent, a home gets mode-specific house rules.
    device_key: str | None = Field(default=None, min_length=1, max_length=512, pattern=r"^[\x21-\x7e]+$")
    mode: Mode = "normal"


class ConnectResponse(BaseModel):
    url: str
    token: str
    room: str


@app.get("/api/status", tags=["status"], summary="サービス状態を取得する")
async def status() -> dict:
    timeout = aiohttp.ClientTimeout(total=2)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        if settings.inference_on_demand:
            asr_ready = tts_ready = llm_ready = None
        else:
            asr_ready, tts_ready, llm_ready = await asyncio.gather(
                _model_available(http, settings.asr_base_url, settings.asr_model, api_key=settings.asr_api_key),
                _model_available(http, settings.tts_base_url, settings.tts_model, settings.tts_voice, settings.tts_api_key),
                _llm_available(http),
            )
    livekit_ready = await _livekit_available()
    components = {
        "livekit": {"ready": livekit_ready},
        "asr": {"model": settings.asr_model, "ready": asr_ready},
        "tts": {"model": settings.tts_model, "voice": settings.tts_voice, "ready": tts_ready},
        "llm": {"model": settings.llm_model, "ready": llm_ready},
        "inference_mode": "on-demand" if settings.inference_on_demand else "always-on",
    }
    on_demand_configured = all(
        (
            settings.ollama_base_url,
            settings.llm_api_key,
            settings.asr_base_url,
            settings.asr_api_key,
            settings.tts_base_url,
            settings.tts_api_key,
        )
    )
    ready = livekit_ready and (
        on_demand_configured
        if settings.inference_on_demand
        else tts_ready is True and asr_ready is True and llm_ready is True
    )
    return {
        **components,
        "ready": ready,
        "supabase_configured": settings.supabase_configured,
    }


@app.post("/api/connect", response_model=ConnectResponse, tags=["voice"], summary="音声通話の接続情報を発行する")
async def connect(body: ConnectRequest | None = None) -> ConnectResponse:
    if settings.environment == "production":
        raise HTTPException(
            status_code=409,
            detail="一般インターネットの音声はWSS /api/relayを使用してください。直接WebRTCは公開していません。",
        )
    room = f"door-{secrets.token_hex(5)}"
    identity = f"visitor-{secrets.token_hex(4)}"
    reception = None
    if body and body.device_key is not None:
        device = await fetch_device_settings(body.device_key)
        if device is None:
            raise HTTPException(status_code=502, detail="Supabaseから端末の設定を取得できません。")
        house_rules = build_house_rules(body.mode, device.house, settings.max_house_rules_chars)
        reception = relay.reception_metadata(body.device_key, device)
    else:
        house_rules = body.house_rules.strip() if body and body.house_rules is not None else settings.house_rules
    if len(house_rules) > settings.max_house_rules_chars:
        raise HTTPException(status_code=422, detail="住人ルールが長すぎます。")

    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name("来訪者")
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )
    try:
        await _dispatch_agent(room, house_rules, reception)
    except Exception as exc:
        logger.warning("agent dispatch failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="音声エージェントを開始できません。") from exc
    return ConnectResponse(url=settings.livekit_ws_url, token=token, room=room)


async def _synthesize_preview(text: str) -> bytes:
    timeout = aiohttp.ClientTimeout(total=60, connect=5, sock_read=45)
    body = {
        "model": settings.tts_model,
        "input": text,
        "voice": settings.tts_voice,
        "language": "ja",
        "seed": settings.tts_seed,
        "response_format": "pcm",
        "stream_format": "sse",
    }
    if settings.tts_instructions:
        body["instructions"] = settings.tts_instructions
    pcm = bytearray()

    def append_pcm(chunk: bytes) -> None:
        if len(pcm) + len(chunk) > settings.max_tts_response_bytes:
            raise HTTPException(status_code=502, detail="音声モデルの応答が上限を超えました。")
        pcm.extend(chunk)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(
                f"{settings.tts_base_url}/v1/audio/speech", json=body,
                headers={"Authorization": f"Bearer {settings.tts_api_key}"},
            ) as response:
                if response.status != 200:
                    raise HTTPException(status_code=503, detail="音声モデルに接続できません。")
                if response.content_type == "text/event-stream":
                    async for raw in response.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if event.get("type") == "speech.audio.delta":
                            append_pcm(base64.b64decode(event.get("delta") or event.get("audio") or "", validate=True))
                        elif event.get("type") in {"error", "speech.audio.error"}:
                            raise HTTPException(status_code=503, detail="音声の生成に失敗しました。")
                elif response.content_type in {"audio/pcm", "application/octet-stream"}:
                    async for chunk in response.content.iter_chunked(16384):
                        append_pcm(chunk)
                else:
                    raise HTTPException(status_code=503, detail="音声モデルの応答形式に対応していません。")
    except (TimeoutError, aiohttp.ClientError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="音声モデルに接続できません。") from exc

    if not pcm or len(pcm) % 2:
        raise HTTPException(status_code=503, detail="音声モデルから有効な音声を取得できません。")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(settings.tts_sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


@app.post("/api/tts-check", tags=["voice"], summary="固定文のTTSプレビューを取得する")
async def tts_check(scenario: Literal["thanks", "compound"] = "thanks") -> Response:
    wav = await _synthesize_preview(PREVIEW_TEXTS[scenario])
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.websocket("/api/relay")
async def psoc_relay(websocket: WebSocket) -> None:
    """Bridge PCM audio over WSS for devices that cannot use direct WebRTC."""
    global _relay_sessions
    relay.logger.info("relay websocket request secure=%s", websocket.url.scheme == "wss")
    if (
        (settings.environment == "production" and websocket.url.scheme != "wss" and not settings.allow_tailnet_http)
        or not _valid_api_key(websocket.headers.get("authorization", ""))
    ):
        await websocket.close(relay.CLOSE_POLICY)
        return
    await websocket.accept()
    if not _take_request_slot() or _relay_sessions >= settings.max_relay_sessions:
        await websocket.send_json(
            {"type": "error", "code": "busy", "message": "混み合っています。少し待って接続し直してください。"}
        )
        await websocket.close(relay.CLOSE_TRY_AGAIN_LATER)
        return
    _relay_sessions += 1
    try:
        await relay.serve(websocket, dispatch=_dispatch_agent)
    finally:
        _relay_sessions -= 1
