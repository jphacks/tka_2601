"""Always-warm Modal TTS endpoint backed by speech.cpp and Irodori v4.1 Small-MF."""
from __future__ import annotations

import hmac
import os
import subprocess
import time

import httpx
import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

SPEECH_URL = "http://127.0.0.1:18094"
VOLUME = modal.Volume.from_name("monban-speech-cache", create_if_missing=True)
IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ca-certificates", "curl", "zstd", "unzip", "libvulkan1", "vulkan-tools")
    .run_commands("curl -fsSL https://raw.githubusercontent.com/nyosegawa/speech.cpp/v0.9.0/install.sh | sh")
    .env({"PATH": "/root/.local/bin:/usr/local/bin:/usr/bin:/bin"})
    .pip_install("fastapi>=0.115,<1", "httpx>=0.27,<1")
)
app = modal.App("monban-irodori-tts")


@app.function(image=IMAGE, volumes={"/models": VOLUME}, cpu=2, memory=8192, timeout=900)
def prepare_model() -> None:
    env = {**os.environ, "XDG_CACHE_HOME": "/models/cache"}
    subprocess.run(["speech", "pull", "irodori-tts-mf"], env=env, check=True)
    VOLUME.commit()


def _authorized(request: Request) -> None:
    expected = os.getenv("MONBAN_TTS_API_TOKEN", "").encode()
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").encode()
    if not expected or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.function(
    image=IMAGE,
    gpu=["L4", "A10"],
    cpu=4,
    memory=16384,
    volumes={"/models": VOLUME},
    secrets=[modal.Secret.from_name("monban-inference")],
    # Always one warm container: a cold start or a T4 added seconds to the first reply (#82).
    min_containers=1,
    scaledown_window=60,
    timeout=900,
)
@modal.asgi_app()
def web():
    env = {**os.environ, "XDG_CACHE_HOME": "/models/cache"}
    subprocess.Popen(
        ["speech", "serve", "irodori-tts-mf", "--host", "127.0.0.1", "--port", "18094"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(600):
        try:
            if httpx.get(f"{SPEECH_URL}/health", timeout=2).is_success:
                break
        except httpx.HTTPError:
            time.sleep(1)
    else:
        raise RuntimeError("speech.cpp did not become ready")

    api = FastAPI()

    async def proxy(request: Request, path: str):
        _authorized(request)
        client = httpx.AsyncClient(timeout=None)
        upstream_request = client.build_request(
            request.method, f"{SPEECH_URL}/{path}",
            content=await request.body(),
            headers={key: value for key, value in request.headers.items()
                     if key.lower() in {"content-type", "accept"}},
        )
        try:
            upstream = await client.send(upstream_request, stream=True)
        except Exception:
            await client.aclose()
            raise

        async def close_upstream():
            await upstream.aclose()
            await client.aclose()

        return StreamingResponse(
            upstream.aiter_bytes(), status_code=upstream.status_code,
            headers={key: value for key, value in upstream.headers.items()
                     if key.lower() in {"content-type", "x-request-id", "x-sample-rate"}},
            background=BackgroundTask(close_upstream),
        )

    @api.get("/v1/models")
    async def models(request: Request):
        return await proxy(request, "v1/models")

    @api.post("/v1/audio/speech")
    async def speech(request: Request):
        return await proxy(request, "v1/audio/speech")

    return api
