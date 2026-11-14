"""Compare where to suppress noise for MONBAN voice turns (Issue #72).

Conditions, applied to the same 16 kHz PCM segment XIAO would send:
  a   none (current relay v2: vad=None, manual turns)
  b   Silero VAD with the old LiveKit path settings: drop turns without speech, trim noise
  c   DeepFilterNet3 before ASR
  c2  DeepFilterNet3 with attenuation limited to 12 dB (atten_lim_db=12)
  d   DeepFilterNet3, then Silero VAD on the enhanced audio
  e   XIAO candidate voice_noise.c as the firmware calls it (idle-learned profile,
      RMS ceiling, bypass when no profile)
  e2  XIAO voice_noise_core.c with the profile forced from idle (ceiling ignored)
ASR is kotoba-tech/kotoba-whisper-v2.1 called like deploy/modal/asr.py (fp16,
one turn per call, language=Japanese, task=transcribe). Also runs the XIAO RMS
endpointing (voice_capture.c) on each stream.

Stages (the ASR stage can run on another machine with a GPU):
    python evaluate.py prepare CORPUS_DIR XIAO_BUILD_DIR WORK_DIR   # Mac/CPU
    python evaluate.py asr WORK_DIR --device cuda                    # GPU host
    python evaluate.py dfgpu WORK_DIR CORPUS_DIR --device cuda       # optional timing
    python evaluate.py score WORK_DIR                                # metrics
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import subprocess
import tempfile
import time
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 16000
GATE = 600  # firmware/xiao/voice_settings.h VOICE_RMS_GATE
GREETING_FRAMES = 150  # 3 s greeting playback between idle learning and listening
MODEL_ID = "kotoba-tech/kotoba-whisper-v2.1"
CONDITIONS = ["a", "b", "c", "c2", "d", "e", "e2"]

# Old LiveKit path (voice/agent.py): activation 0.6, min speech 0.35 s,
# min silence 0.5 s, prefix padding 0.4 s.
VAD_THRESHOLD, VAD_MIN_SPEECH_MS, VAD_MIN_SILENCE_MS, VAD_PREFIX_S, VAD_SUFFIX_S = 0.6, 350, 500, 0.4, 0.5

KEYWORDS = {
    "d1": r"宅急便|宅配", "d2": r"お?届け", "d3": r"郵便", "d4": r"荷物|お届け|宅配",
    "d5": r"配達|置き配", "d6": r"書留|お届け", "o1": r"点検", "o2": r"回線|ご?案内",
    "o3": r"回覧板", "c1": r"ありがとうございました", "c2": r"また来ます|またきます",
    "c3": r"失礼します|失礼いたします|また来ます",
}
DELIVERY = r"宅急便|宅配|配達|お届け|届け物|荷物|郵便|書留|置き配"
PUNCT = re.compile(r"[\s、。，．,.!?！？「」『』…・〜~ー\-]")


def normalize(text: str) -> str:
    return PUNCT.sub("", unicodedata.normalize("NFKC", text))


def edits(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def read(path: Path) -> np.ndarray:
    audio, rate = sf.read(path, dtype="int16")
    assert rate == RATE and audio.ndim == 1
    return audio


def key(pcm: np.ndarray) -> str:
    return hashlib.sha1(pcm.astype("<i2").tobytes()).hexdigest()


# --------------------------------------------------------------------------- prepare
class Vad:
    def __init__(self):
        from silero_vad import get_speech_timestamps, load_silero_vad

        self.model = load_silero_vad()
        self.get = get_speech_timestamps

    def __call__(self, pcm: np.ndarray) -> tuple[np.ndarray | None, float]:
        import torch

        t0 = time.perf_counter()
        wav = torch.from_numpy(pcm.astype(np.float32) / 32768.0)
        stamps = self.get(wav, self.model, threshold=VAD_THRESHOLD, sampling_rate=RATE,
                          min_speech_duration_ms=VAD_MIN_SPEECH_MS, min_silence_duration_ms=VAD_MIN_SILENCE_MS,
                          speech_pad_ms=0)
        sec = time.perf_counter() - t0
        if not stamps:
            return None, sec
        start = max(0, stamps[0]["start"] - int(VAD_PREFIX_S * RATE))
        end = min(pcm.size, stamps[-1]["end"] + int(VAD_SUFFIX_S * RATE))
        return pcm[start:end], sec


class DeepFilter:
    def __init__(self, device: str = "cpu", atten_lim_db: float | None = None):
        import sys
        import types

        import torch

        try:  # df/io.py imports a path removed from newer torchaudio; enhance() does not use it.
            import torchaudio.backend.common  # noqa: F401
        except ImportError:
            shim = types.ModuleType("torchaudio.backend.common")
            shim.AudioMetaData = object
            sys.modules.setdefault("torchaudio.backend", types.ModuleType("torchaudio.backend"))
            sys.modules["torchaudio.backend.common"] = shim
        from df.enhance import enhance, init_df

        self.model, self.state, _ = init_df(log_level="ERROR")
        self.device = device
        self.atten_lim_db = atten_lim_db
        if device != "cpu":
            self.model = self.model.to(device)
        self.enhance = enhance
        self.sr = self.state.sr()
        self.torch = torch

    def __call__(self, pcm: np.ndarray) -> tuple[np.ndarray, float]:
        from scipy.signal import resample_poly

        t0 = time.perf_counter()
        x = resample_poly(pcm.astype(np.float32) / 32768.0, self.sr // RATE, 1).astype(np.float32)
        y = self.enhance(self.model, self.state, self.torch.from_numpy(x)[None], atten_lim_db=self.atten_lim_db).squeeze(0).cpu().numpy()
        out = resample_poly(y, 1, self.sr // RATE)[: pcm.size]
        if self.device == "cuda":
            self.torch.cuda.synchronize()
        sec = time.perf_counter() - t0
        return np.clip(np.round(out * 32768.0), -32768, 32767).astype(np.int16), sec


def xiao(binary: Path, mode: str, idle: np.ndarray, seg: np.ndarray) -> tuple[np.ndarray | None, dict]:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        idle.astype("<i2").tofile(tmp / "idle.raw")
        seg.astype("<i2").tofile(tmp / "seg.raw")
        out = tmp / "out.raw"
        capture = mode == "capture"
        res = subprocess.run([str(binary), mode, str(GATE), "0" if capture else str(GREETING_FRAMES),
                              str(tmp / "idle.raw"), str(tmp / "seg.raw"), "-" if capture else str(out)],
                             check=True, capture_output=True, text=True)
        info = json.loads(res.stdout)
        pcm = None if capture else np.fromfile(out, dtype="<i2")
    return pcm, info


def prepare(args: argparse.Namespace) -> None:
    import torch

    torch.set_num_threads(args.threads)  # per-turn CPU cost on one core group, like one relay session
    manifest = json.loads((args.corpus / "manifest.json").read_text(encoding="utf-8"))
    items = manifest["items"][: args.limit or None]
    binary = args.xiao_build / "xiao_host"
    audio_dir = args.work / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    vad, dfn, dfn12 = Vad(), DeepFilter(), DeepFilter(atten_lim_db=12)
    vad(np.zeros(RATE, dtype=np.int16)), dfn(np.zeros(RATE, dtype=np.int16))  # warm-up
    prepared = []
    for n, item in enumerate(items, 1):
        idle = read(args.corpus / "wav" / f"{item['id']}.idle.wav")
        seg = read(args.corpus / "wav" / f"{item['id']}.wav")
        _, cap = xiao(binary, "capture", idle, seg)
        speech_frame = cap["lead_frames"] + round(item.get("speech_start_s", 0.2) * 50)
        endpoint = {
            "started": cap["started"],
            "false_start": cap["started"] and item["kind"] != "noise_only" and cap["trigger_frame"] < speech_frame,
            "end": {0: "none", 1: "silence", 2: "limit"}.get(cap["end"], str(cap["end"])),
            "turn_s": round(cap["emitted_frames"] * 0.02, 2),
        }
        if item["kind"] != "noise_only" and cap["end"] == 1:
            endpoint["end_after_speech_s"] = round(
                (cap["end_frame"] - cap["lead_frames"]) * 0.02 - item["speech_end_s"], 2)
        enhanced, df_sec = dfn(seg)
        enhanced12, df12_sec = dfn12(seg)
        cropped, vad_sec = vad(seg)
        cropped2, vad2_sec = vad(enhanced)
        out_e, info_e = xiao(binary, "ns", idle, seg)
        out_e2, info_e2 = xiao(binary, "core", idle, seg)
        variants = {
            "a": (seg, {}),
            "b": (cropped, {"vad_cpu_s": vad_sec}),
            "c": (enhanced, {"df_cpu_s": df_sec}),
            "c2": (enhanced12, {"df_cpu_s": df12_sec}),
            "d": (cropped2, {"df_cpu_s": df_sec, "vad_cpu_s": vad2_sec}),
            "e": (out_e, {"xiao_active": info_e["active"], "xiao_host_us_per_frame": info_e["host_us_per_frame"]}),
            "e2": (out_e2, {"xiao_active": info_e2["active"], "xiao_host_us_per_frame": info_e2["host_us_per_frame"]}),
        }
        record = {"item": item, "endpoint": endpoint, "variants": {}}
        for cond, (pcm, extra) in variants.items():
            k = None
            if pcm is not None:
                k = key(pcm)
                path = audio_dir / f"{k}.wav"
                if not path.exists():
                    sf.write(path, pcm, RATE, subtype="PCM_16")
            record["variants"][cond] = {"audio": k, "audio_s": 0 if pcm is None else round(pcm.size / RATE, 3), **extra}
        prepared.append(record)
        if n % 50 == 0:
            print(f"prepared {n}/{len(items)}", flush=True)
    (args.work / "prepared.json").write_text(json.dumps({
        "cpu": platform.processor() or platform.machine(), "torch_threads": args.threads,
        "records": prepared}, ensure_ascii=False), encoding="utf-8")
    print(f"prepared {len(prepared)} items, {len(list(audio_dir.glob('*.wav')))} unique audio files")


# --------------------------------------------------------------------------- asr
def asr(args: argparse.Namespace) -> None:
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

    dtype = torch.float32 if args.device == "cpu" else torch.float16
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        MODEL_ID, torch_dtype=dtype, low_cpu_mem_usage=True, use_safetensors=True).to(args.device)
    pipe = pipeline("automatic-speech-recognition", model=model, tokenizer=processor.tokenizer,
                    feature_extractor=processor.feature_extractor, torch_dtype=dtype, device=args.device)

    def sync() -> None:
        if args.device == "cuda":
            torch.cuda.synchronize()
        elif args.device == "mps":
            torch.mps.synchronize()

    out_path = args.work / "asr.json"
    done = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    files = sorted((args.work / "audio").glob("*.wav"))
    for _ in range(3):  # warm-up
        pipe({"raw": np.zeros(RATE * 2, dtype=np.float32), "sampling_rate": RATE},
             generate_kwargs={"language": "Japanese", "task": "transcribe"})
    sync()
    for n, path in enumerate(files, 1):
        if path.stem in done:
            continue
        # asr.py reads the uploaded WAV with soundfile as float32 and averages channels.
        audio, rate = sf.read(path, dtype="float32", always_2d=True)
        assert rate == RATE
        t0 = time.perf_counter()
        result = pipe({"raw": audio.mean(axis=1), "sampling_rate": RATE},
                      generate_kwargs={"language": "Japanese", "task": "transcribe"})
        sync()
        done[path.stem] = {"text": str(result.get("text", "")).strip(), "sec": time.perf_counter() - t0}
        if n % 100 == 0:
            out_path.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
            print(f"asr {n}/{len(files)}", flush=True)
    out_path.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    gpu = torch.cuda.get_device_name(0) if args.device == "cuda" else args.device
    (args.work / "asr_env.json").write_text(json.dumps({
        "device": gpu, "torch": torch.__version__, "dtype": str(dtype), "model": MODEL_ID}, indent=1), encoding="utf-8")
    print(f"asr done: {len(done)} on {gpu}")


def dfgpu(args: argparse.Namespace) -> None:
    """DeepFilterNet3 latency on the GPU host (same segments as condition c)."""
    import torch

    prepared = json.loads((args.work / "prepared.json").read_text(encoding="utf-8"))["records"]
    dfn = DeepFilter(args.device)
    dfn(np.zeros(RATE, dtype=np.int16))
    times = {}
    for rec in prepared:
        item = rec["item"]
        if item["voice"] not in (None, "Kyoko"):
            continue
        seg = read(args.corpus / "wav" / f"{item['id']}.wav")
        _, sec = dfn(seg)
        times[item["id"]] = {"sec": sec, "audio_s": seg.size / RATE}
    name = torch.cuda.get_device_name(0) if args.device == "cuda" else args.device
    (args.work / "df_gpu.json").write_text(json.dumps({"device": name, "times": times}, indent=1), encoding="utf-8")
    print(f"df timing {len(times)} on {name}: mean {np.mean([t['sec'] for t in times.values()]):.4f}s")


# --------------------------------------------------------------------------- score
def score(args: argparse.Namespace) -> None:
    prepared = json.loads((args.work / "prepared.json").read_text(encoding="utf-8"))["records"]
    texts = json.loads((args.work / "asr.json").read_text(encoding="utf-8"))
    rows = []
    for rec in prepared:
        item, endpoint = rec["item"], rec["endpoint"]
        ref = normalize(item["text"])
        for cond in CONDITIONS:
            v = dict(rec["variants"][cond])
            k = v.pop("audio")
            hit = texts[k] if k else {"text": "", "sec": 0.0}
            hyp = normalize(hit["text"])
            row = {"id": item["id"], "cond": cond, "kind": item["kind"], "utt": item["utt"], "voice": item["voice"],
                   "noise": item["noise"], "snr_db": item["snr_db"], "level": item.get("level"),
                   "dropped": k is None, "text": hit["text"], "asr_gpu_s": round(hit["sec"], 4), **v,
                   "endpoint": endpoint}
            if item["kind"] == "noise_only":
                row["false_text"] = bool(hyp)
            else:
                row["edits"], row["ref_chars"] = edits(ref, hyp), len(ref)
                row["keyword"] = bool(re.search(KEYWORDS[item["utt"]], hyp))
                row["false_delivery"] = not item["kind"].startswith("delivery") and bool(re.search(DELIVERY, hyp))
            rows.append(row)
    with (args.work / "rows.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} rows to {args.work / 'rows.jsonl'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("corpus", type=Path)
    p.add_argument("xiao_build", type=Path)
    p.add_argument("work", type=Path)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--threads", type=int, default=1)
    p = sub.add_parser("asr")
    p.add_argument("work", type=Path)
    p.add_argument("--device", default="cuda")
    p = sub.add_parser("dfgpu")
    p.add_argument("work", type=Path)
    p.add_argument("corpus", type=Path)
    p.add_argument("--device", default="cuda")
    p = sub.add_parser("score")
    p.add_argument("work", type=Path)
    args = ap.parse_args()
    {"prepare": prepare, "asr": asr, "dfgpu": dfgpu, "score": score}[args.cmd](args)


if __name__ == "__main__":
    main()
