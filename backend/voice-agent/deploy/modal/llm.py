"""On-demand Modal endpoint serving the versioned Monban GGUF through Ollama."""
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

APP_NAME = "monban-v20-llm"
MODEL_ID = os.getenv("MONBAN_MODEL_ID", "monban-reception-v20-e4b-qlora-q4km:20261109")
MODEL_FILE = "/models/v20.gguf"
OLLAMA_URL = "http://127.0.0.1:11434"
VOLUME = modal.Volume.from_name("monban-v20-models", create_if_missing=True)
IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ca-certificates", "curl", "zstd")
    .run_commands("curl -fsSL https://ollama.com/install.sh | sh")
    .pip_install("fastapi>=0.115,<1", "httpx>=0.27,<1")
)
app = modal.App(APP_NAME)


@app.function(image=IMAGE, volumes={"/models": VOLUME}, cpu=4, memory=16384, timeout=900)
def prepare_model() -> None:
    """Import the uploaded GGUF into Ollama's persistent Modal volume once."""
    if not os.path.isfile(MODEL_FILE):
        raise RuntimeError(f"Upload the v20 artifact to the Modal volume first: {MODEL_FILE}")
    env = {**os.environ, "OLLAMA_MODELS": "/models/ollama", "OLLAMA_HOST": OLLAMA_URL}
    subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            if httpx.get(f"{OLLAMA_URL}/api/version", timeout=2).is_success:
                break
        except httpx.HTTPError:
            time.sleep(1)
    else:
        raise RuntimeError("Ollama did not start")
    modelfile = "/tmp/Modelfile"
    with open(modelfile, "w", encoding="utf-8") as stream:
        stream.write(
            f"FROM {MODEL_FILE}\nTEMPLATE {{{{ .Prompt }}}}\nRENDERER gemma4\nPARSER gemma4\n"
            "PARAMETER top_k 40\nPARAMETER top_p 0.95\nPARAMETER num_ctx 2048\n"
            "PARAMETER num_predict 96\nPARAMETER stop <turn|>\nPARAMETER temperature 0.15\n"
        )
    subprocess.run(["ollama", "create", MODEL_ID, "-f", modelfile], env=env, check=True)
    VOLUME.commit()


def _authorized(request: Request) -> None:
    expected = os.getenv("MONBAN_LLM_API_TOKEN", "").encode()
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").encode()
    if not expected or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.function(
    image=IMAGE,
    gpu="L40S",
    cpu=8,
    memory=32768,
    volumes={"/models": VOLUME},
    secrets=[modal.Secret.from_name("monban-inference")],
    min_containers=0,
    scaledown_window=60,
    timeout=900,
)
@modal.asgi_app()
def web():
    env = {
        **os.environ,
        "OLLAMA_MODELS": "/models/ollama",
        "OLLAMA_HOST": OLLAMA_URL,
        "OLLAMA_KEEP_ALIVE": "2m",
    }
    subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(120):
        try:
            if httpx.get(f"{OLLAMA_URL}/api/version", timeout=2).is_success:
                break
        except httpx.HTTPError:
            time.sleep(1)
    else:
        raise RuntimeError("Ollama did not start")

    api = FastAPI()

    @api.get("/v1/models")
    async def models(request: Request):
        _authorized(request)
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(f"{OLLAMA_URL}/v1/models")
        response.raise_for_status()
        return response.json()

    @api.post("/v1/chat/completions")
    async def chat(request: Request):
        _authorized(request)
        body = await request.body()
        client = httpx.AsyncClient(timeout=None)
        try:
            upstream = await client.send(
                client.build_request(
                    "POST", f"{OLLAMA_URL}/v1/chat/completions", content=body,
                    headers={"content-type": request.headers.get("content-type", "application/json")},
                ),
                stream=True,
            )
        except Exception:
            await client.aclose()
            raise

        async def close_upstream():
            await upstream.aclose()
            await client.aclose()

        return StreamingResponse(
            upstream.aiter_bytes(), status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
            background=BackgroundTask(close_upstream),
        )

    return api
