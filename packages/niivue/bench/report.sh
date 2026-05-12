#!/usr/bin/env bash
# Generate a self-contained HTML performance report by running the
# benchmark headlessly against both backends.
#
# Usage:
#   bun run bench:report              # writes ./perf-report.html
#   bun run bench:report custom.html  # custom output path
#
# Tunables (env vars):
#   BENCH_BACKENDS="webgpu webgl2"   # default — both backends
#   BENCH_HEADED=1                   # real GPU (Metal/Vulkan); default uses SwiftShader
#   BENCH_FRAMES=200                 # frames per renderer scenario
#   BENCH_COMPUTE_ITER=100           # iterations per compute scenario
#   BENCH_PORT=4173                  # vite preview port
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
PKG="$ROOT/packages/niivue"

OUT_HTML="${1:-$PKG/perf-report.html}"
case "$OUT_HTML" in
  /*) ;;  # absolute — leave as-is
  *) OUT_HTML="$PWD/$OUT_HTML" ;;
esac

OUTDIR=$(mktemp -d)
PIDFILE=$(mktemp)

cleanup() {
  if [ -s "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -rf "$OUTDIR" "$PIDFILE"
}
trap cleanup EXIT

PORT="${BENCH_PORT:-4173}"
FRAMES="${BENCH_FRAMES:-200}"
COMPUTE_ITER="${BENCH_COMPUTE_ITER:-100}"
BACKENDS="${BENCH_BACKENDS:-webgpu webgl2}"

URL_PARAMS_BASE="autorun=1&renderer=1&compute=1&sweeps=0&tract=0&paced=1&frames=${FRAMES}&computeIter=${COMPUTE_ITER}"

echo "[report] building examples (perf flavor)"
(
  cd "$PKG"
  bun run build:examples:perf
)

echo "[report] starting vite preview on :$PORT"
(
  cd "$PKG"
  bunx --bun vite preview \
    --config vite.config.examples.ts \
    --port "$PORT" \
    --strictPort \
    > "$OUTDIR/preview.log" 2>&1 &
  echo $! > "$PIDFILE"
)

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/examples/benchmark.html" > /dev/null; then
    break
  fi
  sleep 1
done

INPUT_FILES=()
for backend in $BACKENDS; do
  out="$OUTDIR/$backend.json"
  echo
  echo "--- bench: $backend ---"
  (
    cd "$PKG"
    bun run bench \
      "http://localhost:$PORT/examples/benchmark.html?$URL_PARAMS_BASE&backend=$backend" \
      "$out"
  )
  INPUT_FILES+=("$out")
done

if [ -s "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  : > "$PIDFILE"
fi

echo
echo "[report] generating $OUT_HTML"
bun run "$PKG/bench/build-report.ts" "$OUT_HTML" "${INPUT_FILES[@]}"

echo "[report] done: $OUT_HTML"
