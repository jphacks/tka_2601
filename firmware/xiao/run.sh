#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

cli="${ARDUINO_CLI:-/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli}"
config="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
fqbn="esp32:esp32:XIAO_ESP32S3:PSRAM=opi,PartitionScheme=default_8MB"

build() {
  # A newly generated optional header must invalidate an older fallback build.
  "$cli" compile --clean --config-file "$config" --fqbn "$fqbn" \
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
    "$cli" upload --config-file "$config" --fqbn "$fqbn" \
      --port "$2" --input-dir "$PWD/.build" "$PWD"
    ;;
  test) bash tests/run.sh ;;
  e2e) bash tests/e2e.sh ;;
  bench) bash tests/e2e.sh bench ;;
  qemu) bash tests/qemu.sh ;;
  *) echo "Usage: bash run.sh build | test | e2e | bench | qemu | upload PORT" >&2; exit 1 ;;
esac
