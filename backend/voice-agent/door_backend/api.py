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
from pathlib import Path
from typing import Literal

import aiohttp
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.openapi.utils import get_openapi
from starlette.middleware.trustedhost import TrustedHostMiddleware
from livekit import api
from pydantic import BaseModel, Field

from . import relay
from .config import settings

logger = logging.getLogger("door-api")
AGENT_NAME = settings.livekit_agent_name
PREVIEW_TEXTS = {
    "thanks": "ありがとうございます。",
    "compound": "ありがとうございます。それでは、お荷物と置き場所の写真を撮ってください。",
}


class RequestBodyLimitMiddleware:
    """Bound API request bodies, including requests without Content-Length."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length:
            try:
                too_large = int(content_length) > self.max_bytes
            except ValueError:
                too_large = False
            if too_large:
                await Response("Request body is too large", status_code=413)(scope, receive, send)
                return

        buffered = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                buffered.append(message)
                break
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > self.max_bytes:
                    await Response("Request body is too large", status_code=413)(scope, receive, send)
                    return
                buffered.append(message)
                if not message.get("more_body", False):
                    break

        index = 0

        async def replay_receive():
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)


class CapacityLimiter:
    """Bound active work and the number/time of requests waiting for capacity."""

    def __init__(self, active_limit: int, queue_limit: int, wait_seconds: float):
        self.active_limit = active_limit
        self.queue_limit = queue_limit
        self.wait_seconds = wait_seconds
        self._active = 0
        self._waiting = 0
        self._condition = asyncio.Condition()

    async def acquire(self) -> bool:
        async with self._condition:
            if self._active < self.active_limit:
                self._active += 1
                return True
            if self._waiting >= self.queue_limit:
                return False
            self._waiting += 1
            try:
                await asyncio.wait_for(
                    self._condition.wait_for(lambda: self._active < self.active_limit),
                    timeout=self.wait_seconds,
                )
            except asyncio.TimeoutError:
                self._waiting -= 1
                return False
            except asyncio.CancelledError:
                self._waiting -= 1
                raise
            self._waiting -= 1
            self._active += 1
            return True

    async def release(self) -> None:
        async with self._condition:
            self._active -= 1
            self._condition.notify(1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=settings.log_level)
    yield


app = FastAPI(
    title="Door Voice Backend",
    version="1.0.0",
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
        routes=app.routes,
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
WEB_UI_DIR = Path(__file__).with_name("web_ui")
app.mount("/assets", StaticFiles(directory=WEB_UI_DIR / "assets"), name="web-ui-assets")
app.add_middleware(RequestBodyLimitMiddleware, max_bytes=settings.max_api_request_bytes)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))

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
        if settings.environment == "production" and request.url.scheme != "https":
            return Response("HTTPS is required", status_code=400)
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

        if not _take_request_slot():
            return Response(
                "Too Many Requests",
                status_code=429,
                headers={"Retry-After": "60", "Cache-Control": "no-store"},
            )

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
async def root(request: Request) -> Response:
    if settings.environment == "production" and request.url.scheme != "https":
        return Response("HTTPS is required", status_code=400)
    if (request.url.hostname or "").lower() == settings.ui_hostname:
        return FileResponse(WEB_UI_DIR / "index.html", headers={"Cache-Control": "no-store"})
    if settings.environment == "production":
        raise HTTPException(status_code=404)
    return RedirectResponse(url="/docs")


class ConnectRequest(BaseModel):
    house_rules: str | None = Field(default=None, max_length=settings.max_house_rules_chars)


class ConnectResponse(BaseModel):
    url: str
    token: str
    room: str


async def _model_available(
    http: aiohttp.ClientSession, base_url: str, expected_model: str, voice: str | None = None
) -> bool:
    try:
        async with http.get(f"{base_url.rstrip('/')}/v1/models") as response:
            if response.status != 200:
                return False
            data = await response.json()
        match = next((model for model in data.get("data", []) if model.get("id") == expected_model), None)
        if match is None:
            return False
        if voice:
            voices = match.get("speech", {}).get("voices", [])
            return any(item.get("name") == voice for item in voices)
        return True
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
        return False


async def _llm_available(http: aiohttp.ClientSession) -> bool:
    try:
        async with http.get(f"{settings.ollama_base_url}/api/tags") as response:
            if response.status != 200:
                return False
            data = await response.json()
        return any(
            item.get("name") == settings.llm_model or item.get("model") == settings.llm_model
            for item in data.get("models", [])
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
        return False


async def _livekit_available() -> bool:
    try:
        async with api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as client:
            await client.room.list_rooms(api.ListRoomsRequest())
        return True
    except Exception as exc:
        logger.info("livekit health check failed: %s", type(exc).__name__)
        return False


async def _dispatch_agent(room: str, house_rules: str) -> None:
    async with api.LiveKitAPI(
        url=settings.livekit_url,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    ) as client:
        await client.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=AGENT_NAME,
                room=room,
                metadata=json.dumps({"house_rules": house_rules}, ensure_ascii=False),
            )
        )


@app.get("/api/status")
async def status() -> dict:
    timeout = aiohttp.ClientTimeout(total=2)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        asr_ready, tts_ready, llm_ready = await asyncio.gather(
            _model_available(http, settings.asr_base_url, settings.asr_model),
            _model_available(http, settings.tts_base_url, settings.tts_model, settings.tts_voice),
            _llm_available(http),
        )
    livekit_ready = await _livekit_available()
    components = {
        "livekit": {"ready": livekit_ready},
        "asr": {"model": settings.asr_model, "ready": asr_ready},
        "tts": {"model": settings.tts_model, "voice": settings.tts_voice, "ready": tts_ready},
        "llm": {"model": settings.llm_model, "ready": llm_ready},
    }
    return {**components, "ready": all(item["ready"] for item in components.values())}


@app.post("/api/connect", response_model=ConnectResponse)
async def connect(body: ConnectRequest | None = None) -> ConnectResponse:
    room = f"door-{secrets.token_hex(5)}"
    identity = f"visitor-{secrets.token_hex(4)}"
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
        await _dispatch_agent(room, house_rules)
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
            async with http.post(f"{settings.tts_base_url}/v1/audio/speech", json=body) as response:
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
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
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


@app.post("/api/tts-check")
async def tts_check(scenario: Literal["thanks", "compound"] = "thanks") -> Response:
    wav = await _synthesize_preview(PREVIEW_TEXTS[scenario])
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.websocket("/api/relay")
async def psoc_relay(websocket: WebSocket) -> None:
    """PSoC 6 relay (spec.md 5.4). Authenticated with the same Bearer key as the HTTP API."""
    global _relay_sessions
    if (settings.environment == "production" and websocket.url.scheme != "wss") or not _valid_api_key(
        websocket.headers.get("authorization", "")
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
