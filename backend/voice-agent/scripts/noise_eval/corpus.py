"""Build the Issue #72 noise-evaluation corpus (synthetic speech + synthetic noise).

Everything here is synthesized: speech comes from macOS `say` (Japanese voices),
noise is generated numerically or by mixing other `say` sentences (babble). No
real XIAO microphone recording exists in the repository or in the relay log
(the relay log is text only), so results from this corpus must be reported as
synthetic, not as an intercom test.

Output format matches what XIAO sends: 16 kHz, 16-bit, mono PCM.

    python corpus.py OUT_DIR
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, lfilter

RATE = 16000
# Speech level is an assumption (no real XIAO recording). Active-speech RMS
# 2000 = -24 dBFS. The XIAO gate (voice_settings.h) is 600 RMS, the noise
# candidate learns only below min(300, gate*0.75) RMS, and a turn ends only
# after 1.2 s below gate*0.5 = 300 RMS. These absolute thresholds are what make
# the level assumption matter; see the report.
SPEECH_RMS = 2000.0
VOICES = ["Kyoko", "Eddy", "Reed"]
SNRS = [20, 10, 5, 0]
NOISES = ["fan", "traffic", "rain", "babble"]
PRE_S, TAIL_S, IDLE_S = 0.2, 1.2, 3.0

# kind: delivery_short / delivery_long / other / closing
UTTERANCES = [
    ("d1", "delivery_short", "宅急便です"),
    ("d2", "delivery_short", "お届け物です"),
    ("d3", "delivery_short", "郵便です"),
    ("d4", "delivery_long", "宅配便です。お荷物のお届けに参りました。"),
    ("d5", "delivery_long", "こんにちは、配達に来ました。置き配でよろしいでしょうか。"),
    ("d6", "delivery_long", "書留のお届けです。受け取りのサインをお願いできますか。"),
    ("o1", "other", "ガス設備の定期点検に伺いました。"),
    ("o2", "other", "光回線のご案内で回っております。少しお時間よろしいでしょうか。"),
    ("o3", "other", "町内会の回覧板をお持ちしました。"),
    ("c1", "closing", "ありがとうございました"),
    ("c2", "closing", "あとでまた来ます"),
    ("c3", "closing", "失礼します。また来ます"),
]

BABBLE_LINES = [
    "今日はいい天気ですね、どこかに出かけましょうか",
    "昨日のニュース見ましたか、すごかったですよね",
    "駅前のパン屋さん、新しくなったらしいですよ",
    "週末は子どもと公園に行く予定なんです",
    "それでね、あの人がこう言ったのよ",
    "来月の旅行の準備はもう終わりましたか",
]


def say(text: str, voice: str) -> np.ndarray:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "s.wav"
        subprocess.run(
            ["say", "-v", voice, "--file-format=WAVE", f"--data-format=LEI16@{RATE}", "-o", str(path), text],
            check=True,
        )
        audio, rate = sf.read(path, dtype="float32")
    assert rate == RATE
    return trim(audio)


def trim(audio: np.ndarray, floor: float = 1e-3) -> np.ndarray:
    idx = np.flatnonzero(np.abs(audio) > floor)
    return audio[idx[0]: idx[-1] + 1] if idx.size else audio


def active_rms(x: np.ndarray) -> float:
    """RMS over 20 ms frames within 30 dB of the loudest frame (speech-active level)."""
    frames = x[: len(x) // 320 * 320].reshape(-1, 320)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    keep = rms > rms.max() * 10 ** (-30 / 20)
    return float(np.sqrt((frames[keep] ** 2).mean()))


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def pink(n: int, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(spec.size)
    f[0] = 1
    return np.fft.irfft(spec / np.sqrt(f), n)


def band(x: np.ndarray, lo: float | None, hi: float | None, order: int = 4) -> np.ndarray:
    if lo and hi:
        b, a = butter(order, [lo, hi], btype="band", fs=RATE)
    elif hi:
        b, a = butter(order, hi, btype="low", fs=RATE)
    else:
        b, a = butter(order, lo, btype="high", fs=RATE)
    return lfilter(b, a, x)


def make_noise(kind: str, n: int, rng: np.random.Generator, babble_pool: list[np.ndarray]) -> np.ndarray:
    t = np.arange(n) / RATE
    if kind == "fan":  # 換気扇・家電: hum + harmonics + steady pink noise
        hum = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) / k for k, f in enumerate([100, 200, 300, 450], 1))
        x = 0.5 * hum / rms(hum) + band(pink(n, rng), 60, 4000)
    elif kind == "traffic":  # 屋外の道路: low rumble with slow swells (passing cars)
        rumble = band(rng.standard_normal(n), None, 600) + 0.3 * band(rng.standard_normal(n), 600, 3000)
        swell = 0.55 + 0.45 * np.sin(2 * np.pi * t / rng.uniform(3, 6) + rng.uniform(0, 6.28)) ** 2
        x = rumble * swell
    elif kind == "rain":  # 雨: broadband hiss + random droplet clicks
        x = band(rng.standard_normal(n), 300, 7000)
        drops = np.zeros(n)
        idx = rng.integers(0, n, size=int(n / RATE * 120))
        drops[idx] = rng.uniform(-1, 1, idx.size) * 8
        x = x / rms(x) + band(drops, 1000, 7000, 2)
    elif kind == "babble":  # 周囲の話し声 (4 overlapping talkers)
        x = np.zeros(n)
        for _ in range(4):
            seq = np.concatenate([babble_pool[i] for i in rng.permutation(len(babble_pool))])
            while seq.size < n + RATE:
                seq = np.concatenate([seq, seq])
            off = rng.integers(0, RATE)
            seg = seq[off: off + n]
            x += seg / rms(seg)
    else:
        raise ValueError(kind)
    return x / rms(x)


def make_event(kind: str, rng: np.random.Generator, babble_pool: list[np.ndarray]) -> np.ndarray:
    """Noise-only events that could trip the XIAO RMS gate (no visitor speech)."""
    if kind == "door":  # ドア・物音: two knocks / a slam
        n = int(0.6 * RATE)
        x = np.zeros(n)
        for start in (0, int(rng.uniform(0.15, 0.3) * RATE)):
            m = int(0.12 * RATE)
            hit = rng.standard_normal(m) * np.exp(-np.arange(m) / (0.015 * RATE))
            x[start: start + m] += band(hit, 80, 2500)
    elif kind == "car":  # 車の通過
        n = int(rng.uniform(1.5, 2.5) * RATE)
        env = np.hanning(n) ** 2
        x = band(rng.standard_normal(n), None, 800) * env
    elif kind == "wind":  # 風・衣擦れ (mic rumble)
        n = int(rng.uniform(0.8, 1.5) * RATE)
        x = band(rng.standard_normal(n), None, 250) * np.hanning(n)
    elif kind == "bag":  # 袋・紙のがさがさ
        n = int(rng.uniform(0.6, 1.2) * RATE)
        x = band(rng.standard_normal(n), 1500, 7500) * (rng.uniform(0, 1, n) ** 3) * np.hanning(n)
    elif kind == "voices":  # 遠くの話し声 (not the visitor)
        n = int(1.5 * RATE)
        x = np.zeros(n)
        for i in rng.choice(len(babble_pool), 2, replace=False):
            seg = babble_pool[i][:n]
            x[: seg.size] += seg / rms(seg)
    else:
        raise ValueError(kind)
    return x / (np.abs(x).max() + 1e-9)


def to_pcm(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), -32768, 32767).astype(np.int16)


def write(path: Path, x: np.ndarray) -> None:
    sf.write(path, to_pcm(x), RATE, subtype="PCM_16")


def main(out: Path) -> None:
    rng = np.random.default_rng(20261114)
    (out / "wav").mkdir(parents=True, exist_ok=True)
    babble_pool = [say(line, v) for line, v in zip(BABBLE_LINES, ["Flo", "Sandy", "Rocko", "Shelley", "Grandma", "Grandpa"])]
    items = []
    for uid, kind, text in UTTERANCES:
        for voice in VOICES:
            speech = say(text, voice)
            speech = speech * (SPEECH_RMS / active_rms(speech))
            pre, tail, idle = int(PRE_S * RATE), int(TAIL_S * RATE), int(IDLE_S * RATE)
            # Segment as XIAO would send it with ideal endpointing: 200 ms pre-roll
            # (10 frames) + speech + 1.2 s trailing quiet, padded to 20 ms frames.
            seg_len = pre + speech.size + tail
            seg_len += (-seg_len) % 320
            clean = np.zeros(seg_len)
            clean[pre: pre + speech.size] = speech
            for noise in ["clean"] + NOISES:
                for snr in ([None] if noise == "clean" else SNRS):
                    name = f"{uid}_{voice}_{noise}" + ("" if snr is None else f"_{snr}dB")
                    # Low floor even when "clean": a real mic never outputs digital zero.
                    floor = rng.standard_normal(idle + seg_len) * 4.0
                    if noise == "clean":
                        bg = floor
                        noise_rms = 4.0
                    else:
                        noise_rms = SPEECH_RMS / 10 ** (snr / 20)
                        bg = make_noise(noise, idle + seg_len, rng, babble_pool) * noise_rms + floor
                    write(out / "wav" / f"{name}.idle.wav", bg[:idle])
                    write(out / "wav" / f"{name}.wav", clean + bg[idle:])
                    items.append({
                        "id": name, "utt": uid, "kind": kind, "text": text, "voice": voice,
                        "noise": noise, "snr_db": snr, "noise_rms": round(noise_rms, 1),
                        "speech_start_s": PRE_S, "speech_end_s": round(PRE_S + speech.size / RATE, 3),
                    })
    # Noise-only segments (what XIAO would send if a sound tripped the gate).
    for event in ["door", "car", "wind", "bag", "voices"]:
        for level_name, peak in [("weak", 2500.0), ("strong", 9000.0)]:
            for rep in range(3):
                ev = make_event(event, rng, babble_pool) * peak
                pre, tail, idle = int(PRE_S * RATE), int(TAIL_S * RATE), int(IDLE_S * RATE)
                seg_len = pre + ev.size + tail
                seg_len += (-seg_len) % 320
                # Quiet room tone (60 RMS, below the XIAO learning ceiling) around the event.
                bg = rng.standard_normal(idle + seg_len) * 4.0
                bg += make_noise("fan", idle + seg_len, rng, babble_pool) * 60.0
                seg = bg[idle:].copy()
                seg[pre: pre + ev.size] += ev
                name = f"n_{event}_{level_name}_{rep}"
                write(out / "wav" / f"{name}.idle.wav", bg[:idle])
                write(out / "wav" / f"{name}.wav", seg)
                items.append({
                    "id": name, "utt": None, "kind": "noise_only", "text": "", "voice": None,
                    "noise": event, "snr_db": None, "noise_rms": round(rms(ev), 1), "level": level_name,
                })
    (out / "manifest.json").write_text(json.dumps({
        "synthetic": True, "rate": RATE, "speech_rms": SPEECH_RMS, "voices": VOICES,
        "pre_s": PRE_S, "tail_s": TAIL_S, "idle_s": IDLE_S, "items": items,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(items)} items -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
