#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/m5-e84-protocol.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

"${CC:-clang}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I../PSOC_Edge_E84/source -c ../PSOC_Edge_E84/source/m5_protocol.c \
  -o "$test_dir/e84_protocol.o"
"${CXX:-clang++}" -std=c++11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I. -I../PSOC_Edge_E84/source link_protocol.cpp tests/protocol_test.cpp \
  "$test_dir/e84_protocol.o" -o "$test_dir/protocol_test"
"$test_dir/protocol_test"

"${CC:-clang}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I../PSOC_Edge_E84/source -c ../PSOC_Edge_E84/source/voice_protocol.c \
  -o "$test_dir/voice_protocol.o"
"${CXX:-clang++}" -std=c++11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I. -I../PSOC_Edge_E84/source link_protocol.cpp stream_protocol.cpp tests/stream_test.cpp \
  "$test_dir/voice_protocol.o" \
  -o "$test_dir/stream_test"
"$test_dir/stream_test"

for mode in default legacy; do
  mkdir "$test_dir/$mode"
  cp stream_receiver.cpp "$test_dir/$mode/stream_receiver.cpp"
  extra=()
  if [ "$mode" = legacy ]; then
    cp tests/legacy_servo_config.h "$test_dir/$mode/servo_config.h"
    extra=(-DTEST_LEGACY_SERVO_CONFIG)
  else
    cp servo_config.example.h "$test_dir/$mode/servo_config.h"
  fi
  "${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
    ${extra[@]+"${extra[@]}"} -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp \
    "$test_dir/$mode/stream_receiver.cpp" tests/receiver_test.cpp -o "$test_dir/receiver_$mode"
  "$test_dir/receiver_$mode"
done

"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp stream_receiver.cpp \
  tests/calibration_test.cpp -o "$test_dir/calibration"
"$test_dir/calibration"

"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp stream_receiver.cpp \
  tests/timing_test.cpp -o "$test_dir/timing"
"$test_dir/timing"

"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp stream_receiver.cpp \
  tests/exact_servo_test.cpp -o "$test_dir/exact_servo"
"$test_dir/exact_servo"

"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp stream_receiver.cpp \
  tests/end_direction_test.cpp -o "$test_dir/end_direction"

"$test_dir/end_direction"

"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp stream_receiver.cpp \
  tests/servo_release_test.cpp -o "$test_dir/servo_release"
"$test_dir/servo_release"

# Isolated source copy selects a test-only servo_config.h without touching the
# user's calibration file. Exercise manual acknowledgement and disabled mode.
mkdir "$test_dir/manual"
cp stream_receiver.cpp "$test_dir/manual/stream_receiver.cpp"
cp tests/manual_servo_config.h "$test_dir/manual/servo_config.h"
for mode in manual disabled; do
  extra=()
  if [ "$mode" = disabled ]; then extra=(-DTEST_DISABLED); fi
  "${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
    ${extra[@]+"${extra[@]}"} -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp \
    "$test_dir/manual/stream_receiver.cpp" tests/manual_receiver_test.cpp \
    -o "$test_dir/receiver_$mode"
  "$test_dir/receiver_$mode"
done

# Invalid reversal/angle values must fail before PWM in USB and network paths.
mkdir "$test_dir/invalid"
cp stream_receiver.cpp "$test_dir/invalid/stream_receiver.cpp"
cp tests/invalid_servo_config.h "$test_dir/invalid/servo_config.h"
for mode in call end call_angle end_angle; do
  extra=(-DTEST_DISABLED)
  if [ "$mode" = end ]; then extra+=(-DTEST_INVALID_END); fi
  if [ "$mode" = call_angle ]; then extra+=(-DTEST_INVALID_CALL_ANGLE); fi
  if [ "$mode" = end_angle ]; then extra+=(-DTEST_INVALID_END_ANGLE); fi
  "${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
    "${extra[@]}" -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp servo_pwm.cpp \
    "$test_dir/invalid/stream_receiver.cpp" tests/manual_receiver_test.cpp \
    -o "$test_dir/receiver_invalid_$mode"
  "$test_dir/receiver_invalid_$mode"
done
