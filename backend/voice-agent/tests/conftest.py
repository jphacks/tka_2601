import os

os.environ.setdefault("DOOR_API_KEY", "a" * 64)
# Tests must not call the local ASR/LLM/TTS services that warm-up probes.
os.environ.setdefault("DOOR_WARMUP", "0")
