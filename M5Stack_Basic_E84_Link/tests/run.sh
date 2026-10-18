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

mkdir "$test_dir/default"
cp stream_receiver.cpp "$test_dir/default/stream_receiver.cpp"
cp servo_config.example.h "$test_dir/default/servo_config.h"
"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp "$test_dir/default/stream_receiver.cpp" \
  tests/receiver_test.cpp -o "$test_dir/receiver_test"
"$test_dir/receiver_test"

# Isolated source copy selects a test-only servo_config.h without touching the
# user's calibration file. Exercise manual acknowledgement and disabled mode.
mkdir "$test_dir/manual"
cp stream_receiver.cpp "$test_dir/manual/stream_receiver.cpp"
cp tests/manual_servo_config.h "$test_dir/manual/servo_config.h"
for mode in manual disabled; do
  extra=()
  if [ "$mode" = disabled ]; then extra=(-DTEST_DISABLED); fi
  "${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
    ${extra[@]+"${extra[@]}"} -Itests/fakes -I. link_protocol.cpp stream_protocol.cpp \
    "$test_dir/manual/stream_receiver.cpp" tests/manual_receiver_test.cpp \
    -o "$test_dir/receiver_$mode"
  "$test_dir/receiver_$mode"
done
