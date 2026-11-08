#!/bin/bash
# Host tests. Everything compiles from an isolated copy so that private headers
# (api_config.h, wifi_config.h, upload_config.h, servo_config.h, device_config.h) are never used.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d "${TMPDIR:-/tmp}/xiao-host.XXXXXX")"
trap 'rm -rf "${work:?}"' EXIT
src="$work/src"; mkdir "$src"
for file in ./*.c ./*.h ./*.cpp; do
  case "$(basename "$file")" in
    api_config.h|wifi_config.h|upload_config.h|servo_config.h|device_config.h) ;;
    *) cp "$file" "$src/" ;;
  esac
done
cp tests/*.c tests/*.cpp tests/*.h tools/chime_eval_wav.c "$src/"
for file in tests/stubs/*.h; do
  case "$(basename "$file")" in device_config.h) ;; *) cp "$file" "$src/" ;; esac
done
mkdir "$src/mbedtls"; cp tests/stubs/mbedtls/*.h "$src/mbedtls/"
C=(clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -I"$src")
CXX=(clang++ -std=c++17 -Wall -Wextra -Werror -g -fsanitize=address,undefined -I"$src" -Itests/fakes)
run() { echo "--- $1"; "$work/$1" > "$work/$1.log" 2>&1 || { cat "$work/$1.log"; exit 1; }; tail -n 1 "$work/$1.log"; }
s() { for f in "$@"; do printf '%s/%s ' "$src" "$f"; done; }

"${C[@]}" $(s audio_core.c audio_store.c test_audio.c) -lm -o "$work/audio"; run audio
"${C[@]}" $(s audio_core.c chime_detector.c test_chime.c) -lm -o "$work/chime"; run chime
# The WAV tool on a synthetic pair (bash run.sh wav); the full evaluation is bash run.sh eval.
"${C[@]}" $(s audio_core.c chime_detector.c chime_eval_old.c chime_eval.c) -lm -o "$work/chime_eval"
"${C[@]}" $(s audio_core.c chime_detector.c chime_eval_wav.c) -lm -o "$work/chime_eval_wav"
"$work/chime_eval" --wav "$work" > /dev/null
echo "--- chime_eval_wav"
"$work/chime_eval_wav" "$work/enroll.wav" "$work/target.wav" > "$work/wav.log" || { cat "$work/wav.log"; exit 1; }
grep -q '^1 detection(s)' "$work/wav.log" || { cat "$work/wav.log"; exit 1; }
tail -n 1 "$work/wav.log"
"${C[@]}" $(s voice_capture.c voice_capture_harness.c) -lm -o "$work/capture"; run capture
"${C[@]}" $(s relay_protocol.c voice_protocol.c relay_protocol_harness.c xlog_host.c) -o "$work/relay"; run relay
"${C[@]}" $(s relay_protocol.c voice_protocol.c relay_legacy_harness.c xlog_host.c) -o "$work/relay_legacy"; run relay_legacy
"${C[@]}" $(s voice_transport.c device_mode.c device_mode_store_fake.c relay_protocol.c voice_protocol.c voice_transport_harness.c xlog_host.c) -o "$work/transport"; run transport
"${C[@]}" -DTEST_UNPAIRED $(s voice_transport.c device_mode.c device_mode_store_fake.c relay_protocol.c voice_protocol.c voice_transport_harness.c xlog_host.c) -o "$work/transport_unpaired"; run transport_unpaired
"${C[@]}" $(s voice_session_harness.c device_mode.c device_mode_store_fake.c relay_protocol.c voice_protocol.c xlog_host.c) -lm -o "$work/session"; run session
"${C[@]}" -DVOICE_RELAY_PROTOCOL=1 $(s voice_session_harness.c device_mode.c device_mode_store_fake.c relay_protocol.c voice_protocol.c xlog_host.c) -lm -o "$work/session_v1"; run session_v1
"${C[@]}" $(s playback.c playback_test.c xlog_host.c) -o "$work/playback"; run playback
"${C[@]}" $(s audio_core.c chime_detector.c audio_store.c voice_capture.c audio_link.c audio_app.c storage_worker.c audio_app_test.c xlog_host.c) -lm -o "$work/audio_app"; run audio_app
"${C[@]}" $(s audio_core.c audio_store.c door_server.c voice_protocol.c door_server_test.c xlog_host.c) -lm -o "$work/door_server"; run door_server
"${C[@]}" $(s pusher_protocol.c pusher_protocol_test.c) -o "$work/pusher_protocol"; run pusher_protocol
"${C[@]}" -c "$src/pusher_protocol.c" -o "$work/pusher_protocol.o"
cp tests/stubs/device_config.h "$src/"
"${C[@]}" -c "$src/device_http.c" -o "$work/device_http.o"
"${C[@]}" -c "$src/pusher_sync.c" -o "$work/pusher_sync.o"
"${CXX[@]}" "$src/servo_control.cpp" "$src/servo_pwm.cpp" "$src/pusher_sync_test.cpp" \
  "$work/pusher_protocol.o" "$work/device_http.o" "$work/pusher_sync.o" -o "$work/pusher_sync"; run pusher_sync
"${C[@]}" $(s device_mode.c device_mode_sync.c device_mode_store_fake.c device_mode_test.c xlog_host.c) \
  "$work/device_http.o" -o "$work/device_mode"; run device_mode
"${C[@]}" $(s device_mode.c device_mode_sync.c device_mode_store_fake.c device_mode_report_test.c xlog_host.c) \
  "$work/device_http.o" -o "$work/device_mode_report"; run device_mode_report
"${C[@]}" $(s visit_report.c visit_report_test.c xlog_host.c) \
  "$work/device_http.o" -o "$work/visit_report"; run visit_report
rm "$src/device_config.h"
"${CXX[@]}" "$src/device_mode_store.cpp" "$src/device_mode_store_test.cpp" -o "$work/device_mode_store"; run device_mode_store
for t in calibration_test exact_servo_test end_direction_test servo_call_test pusher_assignment_test; do
  "${CXX[@]}" "$src/servo_control.cpp" "$src/servo_pwm.cpp" "$src/$t.cpp" -o "$work/$t"; run "$t"
done
"${CXX[@]}" "$src/tune.cpp" "$src/tune_test.cpp" -o "$work/tune"; run tune

echo "--- Python and page tests"
python3 -m unittest tests/test_receiver.py 2>&1 | tail -n 1
python3 -m unittest discover -s calibration_ui -p 'test_*.py' 2>&1 | tail -n 1
python3 -m unittest tests/test_configure.py 2>&1 | tail -n 1
node tests/ui_test.mjs
echo "PASS: all host tests"
