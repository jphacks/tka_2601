#!/bin/bash
# Boots the ESP32-S3 binary in Espressif's QEMU and drives its real serial console.
# Differs from the shipped build in three ways only, all because of the emulator:
# UART instead of USB CDC, DIO flash instead of QIO, and no USB-only TX timeout call.
set -euo pipefail
cd "$(dirname "$0")/.."
cli="${ARDUINO_CLI:-/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli}"
config="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
tag=esp-develop-9.2.2-20260417
archive=qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-aarch64-apple-darwin.tar.xz
tools="$PWD/.host-build/qemu"
qemu="${XIAO_QEMU:-$tools/qemu/bin/qemu-system-xtensa}"
if [ ! -x "$qemu" ]; then
  mkdir -p "$tools"
  gh release download "$tag" --repo espressif/qemu --pattern "$archive" --dir "$tools" --clobber
  tar xf "$tools/$archive" -C "$tools"
fi
work="$PWD/.host-build/qemu-work"
mkdir -p "$work/xiao"
for file in ./*.c ./*.h ./*.cpp ./*.ino ./partitions.csv; do
  case "$(basename "$file")" in
    api_config.h|wifi_config.h|upload_config.h|servo_config.h) ;;
    *) cp "$file" "$work/xiao/" ;;
  esac
done
sed -i '' '/Serial.setTxTimeoutMs(20);/d' "$work/xiao/xiao.ino"
"$cli" compile --config-file "$config" \
  --fqbn "esp32:esp32:XIAO_ESP32S3:PSRAM=opi,PartitionScheme=default_8MB,CDCOnBoot=cdc,FlashMode=dio" \
  --build-path "$work/build" --jobs 8 "$work/xiao" | grep -E "Sketch uses|Global variables"
cp "$work/build/xiao.ino.merged.bin" "$work/flash.bin"
python3 tests/qemu_check.py "$qemu" "$work/flash.bin"
