#!/bin/bash
# Real backend relay code <-> real firmware call code on this Mac. See tests/e2e_relay.py.
set -euo pipefail
cd "$(dirname "$0")/.."
python_bin="${XIAO_E2E_PYTHON:-}"
if [ -z "$python_bin" ]; then
  venv="$PWD/.host-build/e2e-venv"
  python_bin="$venv/bin/python"
  if [ ! -x "$python_bin" ]; then
    uv venv --python 3.12 "$venv"
    uv pip install --python "$python_bin" ../../backend/voice-agent
  fi
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/xiao-e2e.XXXXXX")"
trap 'rm -rf "${work:?}"' EXIT
src="$work/src"; mkdir "$src"
for file in ./*.c ./*.h ./*.cpp; do
  case "$(basename "$file")" in
    api_config.h|wifi_config.h|upload_config.h|servo_config.h|net_stream.cpp|net_task.cpp|console.cpp|hw_audio.cpp|flash_store.cpp|door_server.c) ;;
    *) cp "$file" "$src/" ;;
  esac
done
cp tests/e2e/api_settings.h tests/e2e/host_firmware.cpp "$src/"
mkdir "$src/mbedtls"; cp tests/stubs/mbedtls/*.h "$src/mbedtls/"
flags=(-g -fsanitize=address,undefined -I"$src" -Itests/fakes)
objects=()
for c in "$src"/*.c; do
  clang -std=c11 -Wall -Wextra -Werror "${flags[@]}" -c "$c" -o "${c%.c}.o"; objects+=("${c%.c}.o")
done
clang++ -std=c++17 -Wall -Wextra "${flags[@]}" "$src"/*.cpp "${objects[@]}" -o "$work/host_firmware"
"$python_bin" tests/e2e_relay.py "$work/host_firmware"
