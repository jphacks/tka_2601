"""Turn evaluate.py output into the Markdown tables of the verification report.

    python summarize.py WORK_DIR > tables.md
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

CONDS = ["a", "b", "c", "c2", "d", "e", "e2"]
LABEL = {"a": "(a) なし", "b": "(b) VAD", "c": "(c) DFN", "c2": "(c') DFN 12dB上限", "d": "(d) DFN+VAD", "e": "(e) XIAO", "e2": "(e') XIAO学習強制"}
SNRS = [None, 20, 10, 5, 0]
SNR_LABEL = {None: "静音", 20: "20 dB", 10: "10 dB", 5: "5 dB", 0: "0 dB"}
NOISE_LABEL = {"fan": "換気扇・家電", "traffic": "道路", "rain": "雨", "babble": "周囲の話し声",
               "door": "ノック・ドア", "car": "車の通過", "wind": "風（マイクの吹かれ）", "bag": "袋・紙の音",
               "voices": "遠くの話し声"}
KIND_LABEL = {"delivery_short": "配送・短い", "delivery_long": "配送・長い", "other": "配送以外", "closing": "終了の挨拶"}


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "-"


def table(head: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(map(str, r)) + " |" for r in rows]
    return "\n".join(out) + "\n"


def cer(rows: list[dict]) -> str:
    e, n = sum(r["edits"] for r in rows), sum(r["ref_chars"] for r in rows)
    return f"{100 * e / n:.1f}%" if n else "-"


def main(work: Path) -> None:
    rows = [json.loads(line) for line in (work / "rows.jsonl").open(encoding="utf-8")]
    speech = [r for r in rows if r["kind"] != "noise_only"]
    noise_only = [r for r in rows if r["kind"] == "noise_only"]
    by = defaultdict(list)
    for r in speech:
        by[(r["cond"], r["snr_db"])].append(r)

    print("### 文字誤り率（CER）：SNR別（雑音4種・話者3人・12文の合計）\n")
    print(table(["条件"] + [SNR_LABEL[s] for s in SNRS] + ["雑音あり全体"], [
        [LABEL[c]] + [cer(by[(c, s)]) for s in SNRS] + [cer([r for r in speech if r["cond"] == c and r["snr_db"] is not None])]
        for c in CONDS]))

    print("### 用件キーワードが取れた割合：SNR別\n")
    print(table(["条件"] + [SNR_LABEL[s] for s in SNRS] + ["雑音あり全体"], [
        [LABEL[c]] + [pct(sum(r["keyword"] for r in by[(c, s)]), len(by[(c, s)])) for s in SNRS] +
        [pct(*(lambda rs: (sum(r["keyword"] for r in rs), len(rs)))(
            [r for r in speech if r["cond"] == c and r["snr_db"] is not None]))]
        for c in CONDS]))

    print("### 用件キーワードが取れた割合：雑音の種類別（SNR 20〜0 dBの合計）\n")
    noises = ["fan", "traffic", "rain", "babble"]
    print(table(["条件"] + [NOISE_LABEL[n] for n in noises], [
        [LABEL[c]] + [pct(*(lambda rs: (sum(r["keyword"] for r in rs), len(rs)))(
            [r for r in speech if r["cond"] == c and r["noise"] == n])) for n in noises]
        for c in CONDS]))

    print("### 用件キーワードが取れた割合：発話の種類別（雑音あり、SNR 10〜0 dB）\n")
    kinds = list(KIND_LABEL)
    print(table(["条件"] + [KIND_LABEL[k] for k in kinds], [
        [LABEL[c]] + [pct(*(lambda rs: (sum(r["keyword"] for r in rs), len(rs)))(
            [r for r in speech if r["cond"] == c and r["kind"] == k and r["snr_db"] in (10, 5, 0)])) for k in kinds]
        for c in CONDS]))

    print("### 発話を捨ててしまった件数・配送と誤って読める文字にした件数（発話あり612件中）\n")
    print(table(["条件", "VADで発話を捨てた", "うち静音", "配送以外・終了の挨拶を配送語つきで書き起こし"], [
        [LABEL[c], sum(r["dropped"] for r in speech if r["cond"] == c),
         sum(r["dropped"] for r in speech if r["cond"] == c and r["snr_db"] is None),
         sum(r["false_delivery"] for r in speech if r["cond"] == c)] for c in CONDS]))

    print("### 雑音だけの区間を文字にした件数（30件中。弱・強の各15件）\n")
    events = ["door", "car", "wind", "bag", "voices"]
    head = ["条件", "合計"] + [NOISE_LABEL[e] for e in events]
    print(table(head, [
        [LABEL[c], f"{sum(r['false_text'] for r in noise_only if r['cond'] == c)}/30"] +
        [f"{sum(r['false_text'] for r in noise_only if r['cond'] == c and r['noise'] == e)}/6" for e in events]
        for c in CONDS]))
    print("雑音だけの区間で出た文字（条件(a)）：\n")
    for r in noise_only:
        if r["cond"] == "a" and r["text"]:
            print(f"- {r['id']}: 「{r['text']}」")
    print()
    trig = [r for r in noise_only if r["cond"] == "a"]
    print(f"XIAOのRMSゲート（600）が雑音だけで発話開始と判定した件数：{sum(r['endpoint']['started'] for r in trig)}/30"
          f"（弱 {sum(r['endpoint']['started'] for r in trig if r['level'] == 'weak')}/15、"
          f"強 {sum(r['endpoint']['started'] for r in trig if r['level'] == 'strong')}/15）\n")

    print("### XIAO側：雑音の学習と発話区切り（条件(a)の素材で、本体の処理をそのまま再現）\n")
    base = [r for r in speech if r["cond"] == "e"]
    hdr = ["SNR（雑音のRMS）", "XIAO候補が有効になった", "発話前に雑音で開始", "1.2秒の無音で終了", "30秒の上限まで続いた", "終了までの時間（中央値）"]
    body = []
    for s in SNRS:
        rs = [r for r in base if r["snr_db"] == s]
        ends = [r["endpoint"].get("end_after_speech_s") for r in rs if r["endpoint"]["end"] == "silence"]
        rms = "4" if s is None else f"{2000 / 10 ** (s / 20):.0f}"
        body.append([f"{SNR_LABEL[s]}（{rms}）", pct(sum(r["xiao_active"] for r in rs), len(rs)),
                     pct(sum(r["endpoint"]["false_start"] for r in rs), len(rs)),
                     pct(sum(r["endpoint"]["end"] == "silence" for r in rs), len(rs)),
                     pct(sum(r["endpoint"]["end"] == "limit" for r in rs), len(rs)),
                     f"{np.median(ends):.2f} 秒" if ends else "-"])
    print(table(hdr, body))

    print("### 処理時間（1回の発話あたり）\n")
    prep = json.loads((work / "prepared.json").read_text(encoding="utf-8"))
    lines = []

    def stat(vals: list[float], unit: float = 1000, suffix: str = "ms") -> str:
        v = np.array(vals) * unit
        return f"平均 {v.mean():.0f} {suffix}、95% {np.percentile(v, 95):.0f} {suffix}"

    seg_s = np.array([r["audio_s"] for r in speech if r["cond"] == "a"])
    lines.append(["Silero VAD（CPU、1スレッド）", prep["cpu"],
                  stat([r["vad_cpu_s"] for r in speech if r["cond"] == "b"])])
    lines.append(["DeepFilterNet3（CPU、1スレッド）", prep["cpu"],
                  stat([r["df_cpu_s"] for r in speech if r["cond"] == "c"])])
    dfg = work / "df_gpu.json"
    if dfg.exists():
        d = json.loads(dfg.read_text(encoding="utf-8"))
        lines.append(["DeepFilterNet3（GPU）", d["device"], stat([t["sec"] for t in d["times"].values()])])
    us = [r["xiao_host_us_per_frame"] for r in speech if r["cond"] == "e2"]
    lines.append(["XIAO候補（20 msあたり、ホストのCPU）", prep["cpu"], f"平均 {np.mean(us):.0f} µs"])
    env = json.loads((work / "asr_env.json").read_text(encoding="utf-8")) if (work / "asr_env.json").exists() else {"device": "?"}
    for c in CONDS:
        rs = [r for r in speech if r["cond"] == c and not r["dropped"]]
        lines.append([f"ASR {LABEL[c]}（GPU、fp16）", env["device"], stat([r["asr_gpu_s"] for r in rs]) +
                      f"（音声 平均 {np.mean([r['audio_s'] for r in rs]):.2f} 秒）"])
    print(table(["処理", "環境", "時間"], lines))
    print(f"区間の長さ（条件(a)）：平均 {seg_s.mean():.2f} 秒\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
