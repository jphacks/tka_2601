#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

usage="Usage: bash run.sh build | test | eval | wav ENROLL.wav TARGET.wav | e2e | e2e-rust | browser | bench | qemu [ui] | upload PORT"
fqbn="esp32:esp32:XIAO_ESP32S3:PSRAM=opi,PartitionScheme=default_8MB"

build() {
  source ./tools_env.sh
  ensure_core
  # A newly generated optional header must invalidate an older fallback build.
  "$cli" "${config_args[@]+"${config_args[@]}"}" compile --clean --fqbn "$fqbn" \
    --warnings default --build-path "$PWD/.build" --jobs 8 "$PWD"
}

case "${1:-build}" in
  build) build ;;
  upload)
    if [ -z "${2:-}" ]; then
      echo "Usage: bash run.sh upload /dev/cu.usbmodem..." >&2
      exit 1
    fi
    build
    "$cli" "${config_args[@]+"${config_args[@]}"}" upload --fqbn "$fqbn" \
      --port "$2" --input-dir "$PWD/.build" "$PWD"
    ;;
  test) bash tests/run.sh ;;
  # Synthetic chime evaluation, old detector vs new (tests/chime_eval.c).
  # CHIME_EVAL_FLAGS="-DCHIME_GATE_FACTOR=3.0f" overrides a constant for a sweep.
  eval)
    mkdir -p .host-build
    clang -std=c11 -O2 -Wall -Wextra -Werror ${CHIME_EVAL_FLAGS:-} -I. -Itests audio_core.c chime_detector.c \
      tests/chime_eval_old.c tests/chime_eval.c -lm -o .host-build/chime_eval
    .host-build/chime_eval "${@:2}"
    ;;
  # Detection times in a recording: registration WAV (2 s of background, then
  # one ring) and the WAV to search, both 16 kHz mono 16 bit.
  wav)
    if [ -z "${3:-}" ]; then
      echo "Usage: bash run.sh wav ENROLL.wav TARGET.wav" >&2
      exit 1
    fi
    mkdir -p .host-build
    clang -std=c11 -O2 -Wall -Wextra -Werror -I. audio_core.c chime_detector.c tools/chime_eval_wav.c \
      -lm -o .host-build/chime_eval_wav
    .host-build/chime_eval_wav "$2" "$3"
    ;;
  e2e) bash tests/e2e.sh ;;
  # The same host end-to-end test against the Rust backend (backend/monban-rs).
  e2e-rust) bash tests/e2e.sh rust ;;
  browser) bash tests/browser.sh ;;
  bench) bash tests/e2e.sh bench ;;
  qemu) bash tests/qemu.sh "${2:-}" ;;
  *) echo "$usage" >&2; exit 1 ;;
esac
