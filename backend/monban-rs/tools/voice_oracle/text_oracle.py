"""Record what the Python TTS text helpers do, as the oracle for the Rust port (Issue #79).

Covers livekit-agents' ``filter_markdown`` (streamed, chunk by chunk) and ``filter_emoji``
(the default ``tts_text_transforms``), and speech_tts.py's ``_split_sentences`` and
``_trim_delayed_audio_tail``. The Rust tests in ``tests/voice_clients_text.rs`` replay every
case and require identical output.

Run from backend/voice-agent:

    DOOR_API_KEY=$(python3 -c "print('k'*40)") \
      /path/to/backend/voice-agent/.venv/bin/python ../monban-rs/tools/voice_oracle/text_oracle.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent.parent / "crates" / "monban-backend" / "tests" / "fixtures" / "voice_clients" / "text.json"

os.environ.setdefault("DOOR_WARMUP", "0")
sys.path.insert(0, os.getcwd())

# The oracle must not depend on a developer's .env (find_dotenv walks up to the repository).
import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *args, **kwargs: False

from livekit.agents.voice.transcription.filters import filter_emoji, filter_markdown  # noqa: E402

from monban_backend.voice.speech_tts import _split_sentences, _trim_delayed_audio_tail  # noqa: E402

TEXTS = [
    "",
    "はい、どちら様でしょうか。",
    "承知しました。よろしくお願いいたします。",
    "回覧板はポストに入れてください。入らない場合はお知らせください。",
    "**重要**：荷物は*玄関前*に置いてください。",
    "***とても大事***なお知らせです。",
    "__下線__と_斜体_と___三重___。",
    "snake_case と __dunder__ はそのまま。",
    "a_b@x.com に連絡、5 * 3 = 15、2**10 も計算。",
    "# 見出し\n本文です。\n## 小見出し\n- 項目1\n- 項目2\n* 星の項目\n+ 足しの項目\n> 引用です\n",
    "---\n***\n___\n* * *\n- - -\n    ----\n本文",
    "[リンク](https://example.com)と![画像](https://example.com/a.png)です。",
    "[1] 参考文献 [未完成のリンク",
    "`code` と ```python\nprint(1)\n``` の例。",
    "~~取り消し~~残す。~~ 空白 ~~も。",
    "**_入れ子_**と_**入れ子**_と**~~打ち消し~~**。",
    "絵文字😀👍🏽と❤️と👨‍👩‍👧と1️⃣と★☆と✅です。",
    "Hello, world! This is **bold** and *italic*. Done?",
    "Price: 5*3*2 and *not closed",
    "日本語**強調**日本語、한국어**강조**입니다、ไทย*เน้น*ครับ。",
    "abc*def*ghi と abc_def_ghi。",
    "末尾に空白 ",
    "記号で終わる#",
    "感嘆！疑問？混在!?終わり。」次の文。』最後）",
    "「こんにちは。」と言いました。（はい！）続き",
    "。。。！？　空白の後。\x1c区切り文字\x1d。",
    "改行\nを含む\n\n文章。\r\nCRLFも。",
    "全角ａｂｃ＿ｄｅｆ＿と①②③、²ど濁点。",
    "* 非改行空白*と*　全角空白*と*\x1cFS*。",
    "番号付き\n1. 一つ目\n2. 二つ目\n",
    "> 引用\n>> 二重引用\n  - 字下げ項目\n",
    "**未完の強調で終わる",
    "_",
    "***",
    "~~",
    "`",
    "[]()",
    "![](x)",
    "ご予約の**山田太郎**様ですね。15時から*ジェルネイル*のご予約を確認しました🙂",
]

TOKEN_TEXTS = [
    "A **bold** move, then *more*; done.",
    "テスト、**強調**。次は_下線_？最後！",
]


async def run_markdown(chunks: list[str]) -> list[str]:
    async def source():
        for chunk in chunks:
            yield chunk

    return [out async for out in filter_markdown(source())]


async def run_emoji(chunks: list[str]) -> list[str]:
    async def source():
        for chunk in chunks:
            yield chunk

    return [out async for out in filter_emoji(source())]


def chunkings(text: str, rng: random.Random) -> list[list[str]]:
    out = [[text], list(text)]
    for size in (2, 3, 5, 8):
        out.append([text[i : i + size] for i in range(0, len(text), size)])
    for _ in range(3):
        pieces, index = [], 0
        while index < len(text):
            step = rng.randint(1, 7)
            pieces.append(text[index : index + step])
            index += step
        out.append(pieces)
    # an empty chunk in the middle, as an LLM delta can be ""
    if text:
        middle = len(text) // 2
        out.append([text[:middle], "", text[middle:]])
    unique = []
    for chunks in out:
        if chunks not in unique:
            unique.append(chunks)
    return unique


# Integer-only waveforms so Rust regenerates identical input PCM.
def waveform(segments: list[list]) -> bytes:
    out = bytearray()
    seed = 12345
    for kind, samples, amplitude in segments:
        for i in range(samples):
            if kind == "square":
                value = amplitude if (i // 20) % 2 == 0 else -amplitude
            elif kind == "noise":
                seed = (seed * 1103515245 + 12345) % 2147483648
                value = (seed >> 8) % (2 * amplitude + 1) - amplitude
            else:  # silence
                value = 0
            out += int(value).to_bytes(2, "little", signed=True)
    return bytes(out)


TRIM_CASES = [
    # (sample_rate, text, segments)
    (16000, "", [["square", 16000, 8000]]),
    (16000, "はい。", [["square", 8000, 8000], ["silence", 22000, 0], ["square", 4000, 6000]]),
    (16000, "はい。", [["square", 8000, 8000], ["silence", 15000, 0], ["square", 4000, 6000]]),
    (16000, "はい。", [["square", 8000, 8000], ["silence", 16000, 0], ["square", 4000, 6000]]),
    (16000, "はい。", [["square", 8000, 8000], ["silence", 16320, 0], ["square", 4000, 6000]]),
    (16000, "はい。いいえ。", [["square", 8000, 8000], ["silence", 22000, 0], ["square", 4000, 6000]]),
    (16000, "はい!?", [["square", 8000, 8000], ["silence", 22000, 0], ["square", 4000, 6000]]),
    (16000, "はい。", [["square", 8000, 8000], ["noise", 22000, 20], ["square", 4000, 6000]]),
    (16000, "はい。", [["square", 8000, 8000], ["noise", 22000, 40], ["square", 4000, 6000]]),
    (16000, "はい。", [["noise", 8000, 30000], ["noise", 22000, 100], ["noise", 4000, 9000], ["silence", 3000, 0]]),
    (16000, "", [["square", 1000, 8000]]),
    (16000, "", [["square", 1279, 8000]]),
    (16000, "", [["silence", 30000, 0]]),
    (16000, "", [["silence", 2000, 0], ["square", 5000, 3000], ["silence", 17000, 0], ["square", 101, 3000]]),
    (48000, "はい。", [["square", 24000, 8000], ["silence", 60000, 0], ["square", 12000, 6000]]),
    (48000, "はい。", [["square", 24000, 8000], ["silence", 40000, 0], ["square", 12001, 6000]]),
    (24000, "どうぞ", [["square", 12000, 8000], ["silence", 30000, 0], ["square", 7777, 6000], ["silence", 999, 0]]),
    (8000, "はい。", [["square", 4000, 8000], ["silence", 9000, 0], ["square", 2000, 6000]]),
    (44100, "", [["square", 22050, 8000], ["silence", 50000, 0], ["square", 3333, 6000]]),
]


def main() -> None:
    rng = random.Random(79)
    markdown = []
    for text in TEXTS + TOKEN_TEXTS:
        for chunks in chunkings(text, rng):
            md = asyncio.run(run_markdown(chunks))
            emoji = asyncio.run(run_emoji(md))
            markdown.append({"input": chunks, "markdown": md, "tts_text": emoji})

    emoji_cases = []
    for text in TEXTS:
        emoji_cases.append({"input": text, "output": asyncio.run(run_emoji([text]))[0]})

    sentences = []
    for text in TEXTS + [
        " 前後の空白 。 次 ",
        "!!!",
        "」」。",
        "終わりなし",
        "a.b.c",
        "質問？？」次！）」続き",
    ]:
        sentences.append({"input": text, "output": _split_sentences(text)})

    trims = []
    for rate, text, segments in TRIM_CASES:
        pcm = waveform(segments)
        trimmed = _trim_delayed_audio_tail(pcm, rate, text)
        trims.append(
            {
                "sample_rate": rate,
                "text": text,
                "segments": segments,
                "input_bytes": len(pcm),
                "input_sha256": hashlib.sha256(pcm).hexdigest(),
                "output_bytes": len(trimmed),
                "output_sha256": hashlib.sha256(trimmed).hexdigest(),
            }
        )
    # Odd-length PCM (the function slices bytes, not samples).
    odd = waveform([["square", 8000, 8000], ["silence", 22000, 0], ["square", 4000, 6000]]) + b"\x01"
    trimmed = _trim_delayed_audio_tail(odd, 16000, "")
    trims.append(
        {
            "sample_rate": 16000,
            "text": "",
            "segments": [["square", 8000, 8000], ["silence", 22000, 0], ["square", 4000, 6000]],
            "extra_byte": True,
            "input_bytes": len(odd),
            "input_sha256": hashlib.sha256(odd).hexdigest(),
            "output_bytes": len(trimmed),
            "output_sha256": hashlib.sha256(trimmed).hexdigest(),
        }
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(
            {"markdown": markdown, "emoji": emoji_cases, "sentences": sentences, "trim": trims},
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"markdown={len(markdown)} emoji={len(emoji_cases)} sentences={len(sentences)} trim={len(trims)}")


if __name__ == "__main__":
    main()
