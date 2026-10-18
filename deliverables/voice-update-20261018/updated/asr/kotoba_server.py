"""Loopback-only, resident Kotoba ASR; run in labpc's speech_eval_asr_env.

Audio is decoded in memory and is never stored. The ordinary Whisper pipeline
is used explicitly, without the model card's optional punctuation/diarization code.
"""
from contextlib import asynccontextmanager
import io
import logging
import math
import os
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
from kotoba_decoding import decoding_options

MODEL = "kotoba-tech/kotoba-whisper-v2.1"
REVISION = "57a9d8ab771a0124706b67d22509bedd07c36187"
MAX_BYTES = 20 * 1024 * 1024
BEAMS = max(1, min(5, int(os.getenv("KOTOBA_BEAMS", "3"))))
logger = logging.getLogger("kotoba")
lock = threading.Lock()
recognizer = None


@asynccontextmanager
async def lifespan(app):
    global recognizer
    if not torch.cuda.is_available():
        raise RuntimeError("Kotoba requires labpc's CUDA environment")
    torch.set_num_threads(4)
    processor = AutoProcessor.from_pretrained(MODEL, revision=REVISION, local_files_only=True)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        MODEL, revision=REVISION, local_files_only=True,
        torch_dtype=torch.float16, attn_implementation="sdpa",
    ).to("cuda:0").eval()
    recognizer = pipeline(
        "automatic-speech-recognition", model=model,
        tokenizer=processor.tokenizer, feature_extractor=processor.feature_extractor,
        torch_dtype=torch.float16, device="cuda:0", chunk_length_s=30, stride_length_s=5,
        ignore_warning=True,
    )
    # Compile/init CUDA before HTTP readiness is reported.
    with torch.inference_mode():
        recognizer(np.zeros(16000, dtype=np.float32), generate_kwargs={
            "language": "ja", "task": "transcribe", "do_sample": False, "num_beams": BEAMS,
        })
    logger.info("Kotoba ready revision=%s", REVISION)
    yield
    recognizer = None


app = FastAPI(title="Local Kotoba ASR", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ready": recognizer is not None, "model": MODEL, "revision": REVISION, "device": "cuda:0"}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "local"}]}


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...), model: str = Form(MODEL),
    language: str = Form("ja"), response_format: str = Form("json"),
    prompt: str = Form(""), temperature: float = Form(0),
):
    if model != MODEL:
        raise HTTPException(404, "Unknown ASR model")
    if language not in ("ja", "japanese", "Japanese", ""):
        raise HTTPException(400, "Only Japanese transcription is configured")
    if response_format not in ("json", "verbose_json", "text"):
        raise HTTPException(400, "Use json, verbose_json, or text")
    raw = file.file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "Audio exceeds 20 MiB")
    try:
        audio, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(400, "Audio must be a decodable WAV/FLAC recording") from exc
    if len(audio) > rate * 60:
        raise HTTPException(413, "Audio exceeds 60 seconds")
    audio = audio.mean(axis=1)
    if rate != 16000:
        divisor = math.gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
    started = time.perf_counter()
    if not len(audio) or float(np.max(np.abs(audio))) < 0.0001:
        text = ""
    else:
        # One model, one GPU inference at a time. No previous utterance text is
        # fed back into decoding, so hallucinated context cannot accumulate.
        with lock, torch.inference_mode():
            text = recognizer(audio, generate_kwargs=decoding_options(
                recognizer.tokenizer, prompt, beams=BEAMS,
            ))["text"].strip()
    elapsed = time.perf_counter() - started
    logger.info("transcribed audio_sec=%.3f inference_sec=%.3f", len(audio) / 16000, elapsed)
    if response_format == "text":
        return PlainTextResponse(text)
    return {"text": text, "language": "japanese", "duration": len(audio) / 16000, "segments": []}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("KOTOBA_PORT", "18095")), workers=1)
