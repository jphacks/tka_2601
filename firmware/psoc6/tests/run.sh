#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .host-build
clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g \
  -Isource source/audio_core.c source/audio_store.c tests/test_audio.c \
  -lm -o .host-build/test_audio
.host-build/test_audio
python3 -m unittest discover -s tests -p 'test_*.py' -v
