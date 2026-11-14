"""Always-warm Japanese ASR endpoint for Kotoba-Whisper v2.1."""
from __future__ import annotations

import asyncio
import hmac
import io
import os

import modal
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile

MODEL_ID = "kotoba-tech/kotoba-whisper-v2.1"
VOLUME = modal.Volume.from_name("monban-asr-cache", create_if_missing=True)
IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi>=0.115,<1", "python-multipart>=0.0.20", "numpy>=2.0",
        "scipy>=1.14", "soundfile>=0.12", "torch>=2.6", "transformers>=4.57,<5",
        "accelerate>=1.0",
    )
)
app = modal.App("monban-kotoba-asr")
_pipeline = None
_lock = asyncio.Lock()


@app.function(image=IMAGE, volumes={"/models": VOLUME}, cpu=4, memory=8192, timeout=900)
def prepare_model() -> None:
    from huggingface_hub import snapshot_download

    os.environ["HF_HOME"] = "/models/hf"
    os.environ["TRANSFORMERS_CACHE"] = "/models/hf"
    snapshot_download(MODEL_ID, cache_dir="/models/hf")
    VOLUME.commit()


def _authorized(request: Request) -> None:
    expected = os.getenv("MONBAN_ASR_API_TOKEN", "").encode()
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").encode()
    if not expected or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _load_pipeline():
    global _pipeline
    if _pipeline is None:
        os.environ["HF_HOME"] = "/models/hf"
        os.environ["TRANSFORMERS_CACHE"] = "/models/hf"
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

        processor = AutoProcessor.from_pretrained(MODEL_ID, cache_dir="/models/hf")
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            MODEL_ID, cache_dir="/models/hf", torch_dtype=torch.float16,
            low_cpu_mem_usage=True, use_safetensors=True,
        ).to("cuda:0")
        _pipeline = pipeline(
            "automatic-speech-recognition", model=model, tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor, torch_dtype=torch.float16,
            device=0,
        )
        VOLUME.commit()
    return _pipeline


def _infer(audio: np.ndarray, language: str):
    recognizer = _load_pipeline()
    language_name = "Japanese" if language.lower() in {"ja", "ja-jp", "japanese"} else language
    return recognizer(
        {"raw": audio, "sampling_rate": 16000},
        generate_kwargs={"language": language_name, "task": "transcribe"},
    )


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
    api = FastAPI()

    @api.get("/v1/models")
    async def models(request: Request):
        _authorized(request)
        return {"data": [{"id": MODEL_ID, "object": "model"}]}

    @api.post("/v1/audio/transcriptions")
    async def transcribe(
        request: Request,
        file: UploadFile = File(...),
        model: str = Form(default=MODEL_ID),
        language: str = Form(default="ja"),
        response_format: str = Form(default="json"),
    ):
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly

        _authorized(request)
        if model != MODEL_ID:
            raise HTTPException(status_code=404, detail="Model not found")
        raw = await file.read(25 * 1024 * 1024 + 1)
        if len(raw) > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Audio file is too large")
        try:
            audio, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Expected a valid WAV audio file") from exc
        mono = audio.mean(axis=1)
        if sample_rate != 16000:
            divisor = np.gcd(sample_rate, 16000)
            mono = resample_poly(mono, 16000 // divisor, sample_rate // divisor).astype(np.float32)
        async with _lock:
            try:
                result = await asyncio.to_thread(
                    _infer, mono, language,
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail="ASR inference failed") from exc
        text = str(result.get("text", "")).strip()
        if response_format == "text":
            from fastapi.responses import PlainTextResponse
            return PlainTextResponse(text)
        return {"text": text}

    return api
