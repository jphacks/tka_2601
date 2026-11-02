#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

usage="Usage: bash run.sh build | test | e2e | browser | bench | qemu [ui] | upload PORT"
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
  e2e) bash tests/e2e.sh ;;
  browser) bash tests/browser.sh ;;
  bench) bash tests/e2e.sh bench ;;
  qemu) bash tests/qemu.sh "${2:-}" ;;
  *) echo "$usage" >&2; exit 1 ;;
esac
