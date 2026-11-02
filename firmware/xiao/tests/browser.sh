#!/bin/bash
# Opens the bench page in a real Chromium against the real firmware code. See tests/browser/bench.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${XIAO_BROWSER_PORT:-8769}"
(cd tests/browser && npm ci --no-audit --no-fund --silent && \
  if [ -n "${CI:-}" ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi)
mkdir -p .host-build
set -m # the bench gets its own process group, so stopping it stops the firmware and server too
XIAO_BENCH_PORT="$port" bash tests/e2e.sh bench > .host-build/browser-bench.log 2>&1 &
bench=$!
set +m
trap 'kill -TERM -- "-$bench" 2>/dev/null || true' EXIT
for _ in $(seq 1 180); do
  curl -fs -m 2 "http://127.0.0.1:$port/api/target" > /dev/null && break
  if ! kill -0 "$bench" 2>/dev/null; then
    cat .host-build/browser-bench.log >&2
    exit 1
  fi
  sleep 1
done
node tests/browser/bench.mjs "http://127.0.0.1:$port" .host-build/browser-failure.png
