"""Record what livekit's Silero VAD does, as the oracle for the Rust port (crates/monban-vad).

The script has two steps.

1. Audio: synthesize Japanese sentences with macOS ``say`` (16 kHz mono s16le), then compose
   scenarios from them with silence, white noise and gaps (fixed seed). The scenarios are written
   to ``crates/monban-vad/tests/fixtures/<name>.wav``. Existing WAVs are reused, because ``say``
   output changes with the macOS version; pass ``--regenerate-audio`` to rebuild them.
2. Oracle: stream every WAV through ``livekit.plugins.silero.VAD`` (the production settings of
   ``monban_backend/voice/agent.py`` unless the scenario overrides them) in 20 ms and 100 ms
   chunks, and write ``<name>.json`` with the raw model output of every window and every event
   (type, sample index, timestamp, durations, filtered probability, speech audio length and
   sha256).

Run from anywhere with the voice-agent virtualenv:

    /path/to/backend/voice-agent/.venv/bin/python backend/monban-rs/tools/vad_oracle/capture.py
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent.parent / "crates" / "monban-vad" / "tests" / "fixtures"
RATE = 16000
CHUNKS = [320, 1600]  # 20 ms and 100 ms

# backend/voice-agent/monban_backend/voice/agent.py
PRODUCTION = {
    "min_speech_duration": 0.35,
    "min_silence_duration": 0.5,
    "prefix_padding_duration": 0.4,
    "activation_threshold": 0.6,
}

SENTENCES = {
    "delivery": ("Kyoko", "こんにちは、宅配便です。お荷物をお届けに参りました。"),
    "tanaka": ("Eddy", "すみません、田中さんのお宅でしょうか。"),
    "wait": ("Flo", "はい、少々お待ちください。"),
    "registered": ("Kyoko", "郵便局から書留のお届けです。サインをお願いします。"),
    "gas": ("Eddy", "ガスの点検に伺いました。"),
    "short": ("Flo", "あ。"),
}


def say(voice: str, text: str) -> np.ndarray:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "say.wav"
        subprocess.run(
            ["say", "-v", voice, "-o", str(path), "--file-format=WAVE", "--data-format=LEI16@16000", text],
            check=True,
        )
        return read_wav(path)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").copy()


def write_wav(path: Path, data: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.astype("<i2").tobytes())


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype=np.float64)


def noise(rng: np.random.Generator, seconds: float, std: float) -> np.ndarray:
    return rng.normal(0.0, std, int(seconds * RATE))


def to_i16(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), -32768, 32767).astype(np.int16)


def build_scenarios() -> dict[str, dict]:
    """Scenario name -> {audio (float64 samples), options override, flush_after_samples}."""
    rng = np.random.default_rng(20261114)
    u = {name: say(voice, text).astype(np.float64) for name, (voice, text) in SENTENCES.items()}
    cat = np.concatenate
    scenarios: dict[str, dict] = {}

    def add(name: str, audio: np.ndarray, **extra) -> None:
        scenarios[name] = {"audio": audio, **extra}

    add("s01_single", cat([silence(0.8), u["delivery"], silence(1.2)]))
    add("s02_two_utterances", cat([u["tanaka"], silence(1.0), u["wait"], silence(1.0)]))
    add("s03_short_gap", cat([silence(0.5), u["delivery"], silence(0.25), u["wait"], silence(1.0)]))
    background = noise(rng, 6.0, 300.0)
    speech = cat([silence(0.5), u["registered"]])
    background[: len(speech)] += speech[: len(background)]
    add("s04_low_noise", background)
    add("s05_noise_only", noise(rng, 3.0, 1500.0))
    add("s06_silence_only", silence(2.0))
    # Starts with speech and stops while still speaking: no END_OF_SPEECH.
    gas = u["gas"]
    add("s07_cut_mid_speech", gas[: int(len(gas) * 0.7)])
    quiet = cat([silence(0.4), u["tanaka"] * 0.1, silence(1.0)])
    add("s08_quiet", quiet + noise(rng, len(quiet) / RATE, 30.0))
    t = np.arange(int(0.2 * RATE)) / RATE
    tone = 8000.0 * np.sin(2 * np.pi * 1000.0 * t)
    add("s09_short_bursts", cat([silence(0.5), u["short"], silence(1.0), tone, silence(1.0)]))
    add(
        "s10_max_buffered",
        cat([silence(0.3), u["delivery"], u["registered"], silence(1.0)]),
        options={"max_buffered_speech": 1.0},
    )
    # flush() mid-utterance: livekit resets the whole state and drops the partial window.
    add(
        "s11_flush",
        cat([silence(0.6), u["delivery"], silence(0.8), u["wait"], silence(1.0)]),
        flush_after_samples=2 * RATE,
    )
    loud = cat([silence(0.5), u["wait"], silence(1.0)])
    add("s12_snr_low", loud + noise(rng, len(loud) / RATE, 3000.0))
    return scenarios


def prepare_audio(regenerate: bool) -> dict[str, dict]:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    manifest_path = FIXTURES / "scenarios.json"
    if not regenerate and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        return {name: {**meta, "audio": read_wav(FIXTURES / f"{name}.wav")} for name, meta in manifest.items()}
    scenarios = build_scenarios()
    manifest = {}
    for name, sc in scenarios.items():
        audio = to_i16(sc.pop("audio"))
        write_wav(FIXTURES / f"{name}.wav", audio)
        sc["audio"] = audio
        manifest[name] = {k: v for k, v in sc.items() if k != "audio"}
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    return scenarios


async def run_livekit(audio: np.ndarray, chunk: int, options: dict, flush_after: int | None) -> dict:
    from livekit import rtc
    from livekit.agents import vad as lk_vad
    from livekit.plugins import silero
    from livekit.plugins.silero import onnx_model

    raw: list[float] = []
    original_call = onnx_model.OnnxModel.__call__

    def recording_call(self, x):  # type: ignore[no-untyped-def]
        p = original_call(self, x)
        raw.append(float(p))
        return p

    onnx_model.OnnxModel.__call__ = recording_call  # type: ignore[method-assign]
    try:
        vad = silero.VAD.load(**options)
        stream = vad.stream()
        events: list[dict] = []

        async def collect() -> None:
            async for ev in stream:
                frames = b"".join(bytes(f.data) for f in ev.frames)
                item = {
                    "type": ev.type.value,
                    "samples_index": ev.samples_index,
                    "timestamp": ev.timestamp,
                    "speech_duration": ev.speech_duration,
                    "silence_duration": ev.silence_duration,
                    "speaking": ev.speaking,
                    "frames_len": len(frames) // 2,
                    "frames_sha256": hashlib.sha256(frames).hexdigest(),
                }
                if ev.type == lk_vad.VADEventType.INFERENCE_DONE:
                    item["probability"] = ev.probability
                    item["raw_accumulated_speech"] = ev.raw_accumulated_speech
                    item["raw_accumulated_silence"] = ev.raw_accumulated_silence
                events.append(item)

        collector = asyncio.create_task(collect())
        pushed = 0
        flushed = False
        for start in range(0, len(audio), chunk):
            part = audio[start : start + chunk]
            stream.push_frame(
                rtc.AudioFrame(data=part.tobytes(), sample_rate=RATE, num_channels=1, samples_per_channel=len(part))
            )
            pushed += len(part)
            if flush_after is not None and not flushed and pushed >= flush_after:
                stream.flush()
                flushed = True
            await asyncio.sleep(0)
        stream.end_input()
        await collector
        await stream.aclose()
    finally:
        onnx_model.OnnxModel.__call__ = original_call  # type: ignore[method-assign]
    return {"chunk": chunk, "flush_after_samples": flush_after if flushed else None, "raw_probabilities": raw, "events": events}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--regenerate-audio", action="store_true")
    args = parser.parse_args()
    import livekit.agents
    import livekit.plugins.silero
    import onnxruntime

    scenarios = prepare_audio(args.regenerate_audio)
    total = 0
    for name, sc in scenarios.items():
        options = {**PRODUCTION, **sc.get("options", {})}
        runs = [
            asyncio.run(run_livekit(sc["audio"], chunk, options, sc.get("flush_after_samples")))
            for chunk in CHUNKS
        ]
        out = {
            "scenario": name,
            "samples": int(len(sc["audio"])),
            "options": options,
            "versions": {
                "livekit-agents": livekit.agents.__version__,
                "livekit-plugins-silero": livekit.plugins.silero.__version__,
                "onnxruntime": onnxruntime.__version__,
            },
            "runs": runs,
        }
        (FIXTURES / f"{name}.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
        kinds = [e["type"] for e in runs[0]["events"] if e["type"] != "inference_done"]
        total += len(sc["audio"])
        print(f"{name}: {len(sc['audio']) / RATE:.2f}s windows={len(runs[0]['raw_probabilities'])} {kinds}", file=sys.stderr)
    print(f"total audio {total / RATE:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
