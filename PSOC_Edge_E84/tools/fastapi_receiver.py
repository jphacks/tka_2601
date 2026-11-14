"""Optional FastAPI WAV receiver; run with uvicorn --factory, one worker.

No ASR, LLM, notification or actuator is invoked by an upload.
"""
import asyncio
import hmac
import math
import os
from pathlib import Path
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .receiver import MAX_WAV_BYTES, RecordingStore


def create_app(directory=None, token=None):
    """A single configured token identifies one device's private store."""
    token = os.environ.get("AUDIO_RECEIVER_TOKEN", "") if token is None else token
    if not isinstance(token, str) or not 32 <= len(token) < 512 or any(not 33 <= ord(c) <= 126 for c in token):
        raise ValueError("AUDIO_RECEIVER_TOKEN must be a 32-511 character printable Bearer token.")
    store = RecordingStore(Path(directory or os.environ.get("AUDIO_RECEIVER_DIRECTORY", "recordings")))
    app = FastAPI(title="PSOC Edge E84 recording receiver", version="1")
    app.state.store = store
    capacity = asyncio.Semaphore(4)

    def authorized(request):
        values = request.headers.getlist("authorization")
        return len(values) == 1 and hmac.compare_digest(values[0].encode(), ("Bearer " + token).encode())

    @app.get("/api/status")
    async def status(request: Request):
        if not authorized(request):
            return PlainTextResponse("unauthorized\n", status_code=401)
        return JSONResponse({"ready": True, "service": "e84-recordings", "protocol": 1})

    @app.put("/v1/doorbell/recordings/{event_id}", response_class=PlainTextResponse)
    async def upload(event_id: str, request: Request):
        if not authorized(request):
            return PlainTextResponse("unauthorized\n", status_code=401)
        if re.fullmatch(r"[0-9a-f]{32}", event_id) is None:
            return PlainTextResponse("not found\n", status_code=404)
        lengths = request.headers.getlist("content-length")
        if request.headers.get("transfer-encoding") or len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            return PlainTextResponse("one Content-Length is required\n", status_code=400)
        if len(lengths[0]) > 6 or not 44 < int(lengths[0]) <= MAX_WAV_BYTES:
            return PlainTextResponse("invalid audio size\n", status_code=413)
        if request.headers.getlist("content-type") != ["audio/wav"]:
            return PlainTextResponse("expected audio/wav\n", status_code=415)
        length = int(lengths[0])
        versions = request.headers.getlist("x-audio-model-version")
        scores = request.headers.getlist("x-audio-match-score")
        if len(versions) > 1 or (versions and versions[0] != "1") or len(scores) > 1:
            return PlainTextResponse("invalid audio metadata\n", status_code=400)
        try:
            score = float(scores[0]) if scores else None
            if score is not None and (not math.isfinite(score) or (score < 0 and score != -1)):
                raise ValueError()
        except ValueError:
            return PlainTextResponse("invalid match score\n", status_code=400)

        try:
            await asyncio.wait_for(capacity.acquire(), timeout=2)
        except TimeoutError:
            return PlainTextResponse("receiver busy\n", status_code=503, headers={"Retry-After": "2"})
        try:
            async def read_body():
                data = bytearray()
                async for chunk in request.stream():
                    if len(data) + len(chunk) > length:
                        raise ValueError("body exceeds declared length")
                    data.extend(chunk)
                if len(data) != length:
                    raise ValueError("incomplete upload")
                return bytes(data)

            data = await asyncio.wait_for(read_body(), timeout=10)
            created = await run_in_threadpool(store.save, event_id, data, score)
        except FileExistsError:
            return PlainTextResponse("ID conflict\n", status_code=409)
        except (ValueError, TimeoutError, ClientDisconnect):
            return PlainTextResponse("invalid or incomplete audio\n", status_code=400)
        except OSError:
            return PlainTextResponse("storage unavailable\n", status_code=503)
        finally:
            capacity.release()
        return PlainTextResponse(event_id + "\n", status_code=201 if created else 200)

    return app
