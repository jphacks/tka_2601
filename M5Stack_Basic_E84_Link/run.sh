#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

cli="${ARDUINO_CLI:-/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli}"
config="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
fqbn="m5stack:esp32:m5stack_core"
export ARDUINO_BUILD_CACHE_PATH="${TMPDIR:-/tmp}/m5stack-e84-link-arduino-cache"

build() {
  # A newly generated optional header must invalidate an older fallback build.
  "$cli" compile --clean --config-file "$config" --fqbn "$fqbn" \
    --build-path "$PWD/.build" --jobs 8 "$PWD"
}

case "${1:-build}" in
  build) build ;;
  upload)
    if [ -z "${2:-}" ]; then
      echo "Usage: bash run.sh upload /dev/cu.usbserial-..." >&2
      exit 1
    fi
    if [ ! -f link_config.h ]; then
      echo "Run E84 configure_m5.py --prepare-receiver first; link_config.h is missing." >&2
      exit 1
    fi
    build
    "$cli" upload --config-file "$config" --fqbn "$fqbn" \
      --port "$2" --input-dir "$PWD/.build" "$PWD"
    ;;
  *) echo "Usage: bash run.sh build | upload PORT" >&2; exit 1 ;;
esac
