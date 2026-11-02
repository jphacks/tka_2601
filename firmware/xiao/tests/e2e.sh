#!/bin/bash
# Real backend relay code <-> real firmware call code on this Mac. See tests/e2e_relay.py.
# "bench" instead runs the bench page against the same firmware; see tests/bench_host.py.
set -euo pipefail
cd "$(dirname "$0")/.."
python_bin="${XIAO_E2E_PYTHON:-}"
if [ -z "$python_bin" ]; then
  venv="$PWD/.host-build/e2e-venv"
  python_bin="$venv/bin/python"
  if [ ! -f "$venv/.installed" ]; then
    uv venv --allow-existing --python 3.12 "$venv"
    # Only the dependencies: tests/e2e_relay.py imports the backend from its source.
    uv pip install --python "$python_bin" -r ../../backend/voice-agent/pyproject.toml
    touch "$venv/.installed"
  fi
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/xiao-e2e.XXXXXX")"
trap 'rm -rf "${work:?}"' EXIT
src="$work/src"; mkdir "$src"
for file in ./*.c ./*.h ./*.cpp; do
  case "$(basename "$file")" in
    api_config.h|wifi_config.h|upload_config.h|servo_config.h|net_stream.cpp|net_task.cpp|hw_audio.cpp|flash_store.cpp) ;;
    *) cp "$file" "$src/" ;;
  esac
done
cp tests/e2e/api_settings.h tests/e2e/host_firmware.cpp tests/stubs/upload_settings.h "$src/"
mkdir "$src/mbedtls"; cp tests/stubs/mbedtls/*.h "$src/mbedtls/"
flags=(-g -fsanitize=address,undefined -I"$src" -Itests/fakes)
objects=()
for c in "$src"/*.c; do
  clang -std=c11 -Wall -Wextra -Werror "${flags[@]}" -c "$c" -o "${c%.c}.o"; objects+=("${c%.c}.o")
done
clang++ -std=c++17 -Wall -Wextra "${flags[@]}" "$src"/*.cpp "${objects[@]}" -o "$work/host_firmware"
if [ "${1:-}" = bench ]; then
  "$python_bin" tests/bench_host.py "$work/host_firmware"
else
  "$python_bin" tests/e2e_relay.py "$work/host_firmware"
fi
