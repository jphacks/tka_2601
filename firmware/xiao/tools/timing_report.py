#!/usr/bin/env python3
"""XIAOのUSBシリアルのログから、来客対応の待ち時間を集計する（Issue #72）。

使い方: python3 tools/timing_report.py serial.log [more.log ...]

[TIMING] の行（timing.h）を通話ごと・ターンごとにまとめ、次を出す。
- チャイムから挨拶が聞こえるまで: call_start から最初の playback_start まで
- 呼出ボタンの押下を頼むまで: call_start から call_press_requested まで
- 来客が話し終えてから返答が聞こえるまで: ターンごとの speech_end から playback_start まで
  - そのうちサーバー側（認識・生成・合成・通信）: speech_end から reply_start まで
  - そのうち端末側（先読みの溜め込みと再生開始）: reply_start から playback_start まで
最速・中央値・最遅も出す。時刻はXIAOのms時計で、epoch_ms はサーバーのログと照合するために残す。
"""
from __future__ import annotations

import re
import statistics
import sys
from dataclasses import dataclass, field

LINE = re.compile(r"\[TIMING\] event=(\w+) turn=(\d+) ms=(\d+) epoch_ms=(-?\d+)")


@dataclass
class Call:
    start_ms: int
    start_epoch_ms: int
    events: list[tuple[str, int, int]] = field(default_factory=list)  # (event, turn, ms)

    def first(self, event: str, turn: int | None = None) -> int | None:
        for name, event_turn, ms in self.events:
            if name == event and (turn is None or event_turn == turn):
                return ms
        return None

    def turns(self) -> list[int]:
        return sorted({turn for name, turn, _ in self.events if name == "speech_end"})


def parse(lines) -> list[Call]:
    calls: list[Call] = []
    for line in lines:
        match = LINE.search(line)
        if not match:
            continue
        event, turn, ms, epoch_ms = match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))
        if event == "call_start":
            calls.append(Call(ms, epoch_ms))
        elif calls:
            calls[-1].events.append((event, turn, ms))
    return calls


def elapsed(start: int | None, end: int | None) -> int | None:
    if start is None or end is None:
        return None
    # The ms clock is uint32 and wraps after about 49 days.
    return (end - start) % (1 << 32)


def measure(call: Call) -> dict:
    greeting = elapsed(call.start_ms, call.first("playback_start"))
    press = elapsed(call.start_ms, call.first("call_press_requested"))
    replies = []
    for turn in call.turns():
        speech_end = call.first("speech_end", turn)
        replies.append({
            "turn": turn,
            "reply_heard_ms": elapsed(speech_end, call.first("playback_start", turn)),
            "server_ms": elapsed(speech_end, call.first("reply_start", turn)),
            "device_ms": elapsed(call.first("reply_start", turn), call.first("playback_start", turn)),
        })
    return {
        "epoch_ms": call.start_epoch_ms,
        "chime_to_press_ms": press,
        "chime_to_greeting_ms": greeting,
        "replies": replies,
        "ended": call.first("call_end") is not None,
        "end_pressed": call.first("end_press_requested") is not None,
    }


def spread(values: list[int]) -> str:
    if not values:
        return "データなし"
    return f"最速 {min(values)} ms / 中央値 {int(statistics.median(values))} ms / 最遅 {max(values)} ms（{len(values)}件）"


def show(value: int | None) -> str:
    return "-" if value is None else f"{value} ms"


def report(calls: list[Call]) -> str:
    out = []
    greetings, replies, servers, devices = [], [], [], []
    for index, call in enumerate(calls, 1):
        result = measure(call)
        out.append(f"通話{index}（epoch_ms={result['epoch_ms']}）: 押下依頼まで {show(result['chime_to_press_ms'])}、"
                   f"挨拶が聞こえるまで {show(result['chime_to_greeting_ms'])}、"
                   f"終話 {'あり' if result['ended'] else 'なし'}、J3 {'あり' if result['end_pressed'] else 'なし'}")
        if result["chime_to_greeting_ms"] is not None:
            greetings.append(result["chime_to_greeting_ms"])
        for reply in result["replies"]:
            out.append(f"  ターン{reply['turn']}: 返答が聞こえるまで {show(reply['reply_heard_ms'])}"
                       f"（サーバー側 {show(reply['server_ms'])}、端末側 {show(reply['device_ms'])}）")
            for bucket, key in ((replies, "reply_heard_ms"), (servers, "server_ms"), (devices, "device_ms")):
                if reply[key] is not None:
                    bucket.append(reply[key])
    out.append("")
    out.append(f"チャイムから挨拶が聞こえるまで: {spread(greetings)}")
    out.append(f"話し終えてから返答が聞こえるまで: {spread(replies)}")
    out.append(f"  うちサーバー側: {spread(servers)}")
    out.append(f"  うち端末側: {spread(devices)}")
    return "\n".join(out)


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 2
    lines = []
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines.extend(handle)
    calls = parse(lines)
    if not calls:
        print("[TIMING] の call_start が見つかりません。")
        return 1
    print(report(calls))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
