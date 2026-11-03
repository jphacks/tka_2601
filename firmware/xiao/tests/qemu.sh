#!/bin/bash
# Boots the ESP32-S3 binary in Espressif's QEMU and drives its real serial console.
# Differs from the shipped build in three ways only, all because of the emulator:
# UART instead of USB CDC, DIO flash instead of QIO, and no USB-only TX timeout call.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./tools_env.sh

tag=esp-develop-9.2.2-20260417
version=esp_develop_9.2.2_20260417
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) host=aarch64-apple-darwin; sum=bb8c15810565d3df1665dc34962430885e11bc95575b228fb44698146be1e9d6 ;;
  Darwin-x86_64) host=x86_64-apple-darwin; sum=ae8170fe46bcdfa54a7c0d7afcdb7a066711991be680f72ff7bbc6c4ae3ad88f ;;
  Linux-x86_64) host=x86_64-linux-gnu; sum=0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35 ;;
  Linux-aarch64) host=aarch64-linux-gnu; sum=00de5985094c14e47d1b38464a006b8ed64fd0fa7a289c56da24f3a329f65339 ;;
  *) echo "この環境の QEMU はありません: $(uname -s)-$(uname -m)。Windows は WSL で動かしてください。" >&2; exit 1 ;;
esac
tools="$PWD/.host-build/qemu"
qemu="${XIAO_QEMU:-$tools/qemu/bin/qemu-system-xtensa}"
if [ ! -x "$qemu" ]; then
  archive="qemu-xtensa-softmmu-$version-$host.tar.xz"
  mkdir -p "$tools"
  echo "QEMU を取得します: $archive"
  curl -fL --retry 3 -o "$tools/$archive" "https://github.com/espressif/qemu/releases/download/$tag/$archive"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$tools/$archive" | cut -d' ' -f1)"
  else actual="$(shasum -a 256 "$tools/$archive" | cut -d' ' -f1)"; fi
  if [ "$actual" != "$sum" ]; then
    echo "QEMU の SHA-256 が一致しません: $actual" >&2
    rm -f "${tools:?}/${archive:?}"
    exit 1
  fi
  tar xf "$tools/$archive" -C "$tools"
fi
if ! "$qemu" --version >/dev/null 2>&1; then
  echo "QEMU を起動できません。足りないライブラリを入れてください。" >&2
  echo "  macOS: brew install libgcrypt glib pixman sdl2 libslirp" >&2
  echo "  Ubuntu: sudo apt-get install libgcrypt20 libglib2.0-0 libpixman-1-0 libsdl2-2.0-0 libslirp0" >&2
  exit 1
fi

work="$PWD/.host-build/qemu-work"
mkdir -p "$work/xiao"
for file in ./*.c ./*.h ./*.cpp ./*.ino ./partitions.csv; do
  case "$(basename "$file")" in
    api_config.h|wifi_config.h|upload_config.h|servo_config.h) ;;
    *) cp "$file" "$work/xiao/" ;;
  esac
done
grep -v 'Serial.setTxTimeoutMs(20);' xiao.ino > "$work/xiao/xiao.ino"
ensure_core
"$cli" "${config_args[@]+"${config_args[@]}"}" compile \
  --fqbn "esp32:esp32:XIAO_ESP32S3:PSRAM=opi,PartitionScheme=default_8MB,CDCOnBoot=cdc,FlashMode=dio" \
  --build-path "$work/build" --jobs 8 "$work/xiao" | grep -E "Sketch uses|Global variables"
cp "$work/build/xiao.ino.merged.bin" "$work/flash.bin"

if [ "${1:-}" != ui ]; then
  python3 tests/qemu_check.py "$qemu" "$work/flash.bin"
  exit 0
fi

# The bench page on the emulated board. QEMU has no web UI of its own; its serial
# port appears as a pseudo terminal, which the page's server opens like a USB port.
port="${XIAO_QEMU_UI_PORT:-8768}"
"$qemu" -nographic -machine esp32s3 -m 8M -global driver=ssi_psram,property=is_octal,value=true \
  -drive "file=$work/flash.bin,if=mtd,format=raw" -serial pty -monitor none > "$work/qemu.log" 2>&1 &
qemu_pid=$!
trap 'kill "$qemu_pid" 2>/dev/null || true' EXIT
device=""
for _ in $(seq 1 50); do
  device="$(grep -oE '/dev/(ttys|pts/)[0-9]+' "$work/qemu.log" | head -n 1 || true)"
  [ -n "$device" ] && break
  sleep 0.1
done
if [ -z "$device" ]; then
  cat "$work/qemu.log" >&2
  exit 1
fi
echo "マイク、スピーカー、Wi-Fi は QEMU にないので、それらの確認は失敗と出ます。Ctrl-C で止まります。"
python3 calibration_ui/server.py --serial-port "$device" --http-port "$port" --history-file "$work/history.json" --target qemu
