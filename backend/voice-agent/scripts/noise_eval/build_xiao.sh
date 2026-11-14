#!/usr/bin/env bash
# Build the host harness against the XIAO noise-suppression candidate.
#   bash build_xiao.sh OUT_DIR [GIT_REF]
# GIT_REF defaults to the candidate branch; the report pins commit d93de3b.
set -euo pipefail
out=${1:?OUT_DIR}
ref=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
if [[ -z $ref ]]; then
  for candidate in origin/codex/issue-72-noise-suppression codex/issue-72-noise-suppression gh/noise d93de3b; do
    if git -C "$repo" rev-parse -q --verify "$candidate^{commit}" >/dev/null; then ref=$candidate; break; fi
  done
fi
mkdir -p "$out/src"
for f in audio_core.h voice_capture.c voice_capture.h voice_noise.c voice_noise.h voice_noise_core.c voice_noise_core.h; do
  git -C "$repo" show "$ref:firmware/xiao/$f" > "$out/src/$f"
done
git -C "$repo" rev-parse "$ref^{commit}" > "$out/ref.txt"
# Same optimisation level as a typical host test; ESP32-S3 timing is not represented.
cc -std=c11 -O2 -Wall -I"$out/src" -o "$out/xiao_host" \
  "$here/xiao_host.c" "$out/src/voice_capture.c" "$out/src/voice_noise.c" "$out/src/voice_noise_core.c" -lm
echo "built $out/xiao_host from $ref ($(cat "$out/ref.txt"))"
