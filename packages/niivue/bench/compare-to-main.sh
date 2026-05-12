#!/usr/bin/env bash
# Bench the current working tree vs main, locally.
#
# Usage: bun run bench:compare [-- --warn-pct=N --fail-pct=N --noise-ms=N]
#
# Refuses to run while on main. Builds examples (perf flavor) on both sides,
# starts a vite preview, runs the headless bench for each requested backend,
# and diffs the results per backend.
#
# Backends:
#   BENCH_BACKENDS="webgpu webgl2"   # default — bench both, compare each
#   BENCH_BACKENDS="webgpu"          # WebGPU only
#   BENCH_BACKENDS="webgl2"          # WebGL2 only
#
# Set BENCH_HEADED=1 to launch a real browser window for true-GPU numbers
# (Metal on macOS). Headless uses SwiftShader on every platform.
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
PKG="$ROOT/packages/niivue"

BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ]; then
  echo "On main: nothing to compare. Switch to a feature branch first." >&2
  exit 1
fi

OUTDIR=$(mktemp -d)
WORKTREE=$(mktemp -d)
PIDFILE=$(mktemp)

cleanup() {
  if [ -s "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  if [ -e "$WORKTREE/packages" ]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
  rm -rf "$OUTDIR" "$PIDFILE" "$WORKTREE"
}
trap cleanup EXIT

PORT="${BENCH_PORT:-4173}"
FRAMES="${BENCH_FRAMES:-200}"
COMPUTE_ITER="${BENCH_COMPUTE_ITER:-100}"

# Backends to bench, space-separated. Default: both.
#   BENCH_BACKENDS="webgpu"          # WebGPU only
#   BENCH_BACKENDS="webgl2"          # WebGL2 only
#   BENCH_BACKENDS="webgpu webgl2"   # both (default)
BACKENDS="${BENCH_BACKENDS:-webgpu webgl2}"

URL_PARAMS_BASE="autorun=1&renderer=1&compute=1&sweeps=0&tract=0&frames=${FRAMES}&computeIter=${COMPUTE_ITER}"

bench_at() {
  local dir="$1"
  local label="$2"
  echo
  echo "=== bench: $label ($dir) ==="

  if [ "$label" = "base" ]; then
    # Worktree starts without node_modules.
    (cd "$dir" && bun install --frozen-lockfile)
  fi

  # Bootstrap case: when this is the base side and main predates the perf
  # harness (no `build:examples:perf` script or no `bench/` dir), write a
  # schema-less sentinel JSON per backend. compare-bench.ts treats that as
  # "no baseline available" and falls back to head-only reporting instead
  # of failing the gate.
  if [ "$label" = "base" ] && {
    ! grep -q '"build:examples:perf"' "$dir/packages/niivue/package.json" ||
      [ ! -d "$dir/packages/niivue/bench" ]
  }; then
    echo "[bench] base side predates perf infrastructure — writing bootstrap sentinels"
    for backend in $BACKENDS; do
      printf '{"reason":"main predates perf-bench infrastructure","backend":"%s"}\n' \
        "$backend" >"$OUTDIR/$label.$backend.json"
    done
    return 0
  fi

  (
    cd "$dir/packages/niivue"
    bun run build:examples:perf
  )

  rm -f "$PIDFILE"
  (
    cd "$dir/packages/niivue"
    bunx --bun vite preview \
      --config vite.config.examples.ts \
      --port "$PORT" \
      --strictPort \
      > "$OUTDIR/preview-$label.log" 2>&1 &
    echo $! > "$PIDFILE"
  )

  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT/examples/benchmark.html" > /dev/null; then
      break
    fi
    sleep 1
  done

  for backend in $BACKENDS; do
    echo
    echo "--- bench: $label / $backend ---"
    (
      cd "$dir/packages/niivue"
      bun run bench \
        "http://localhost:$PORT/examples/benchmark.html?$URL_PARAMS_BASE&backend=$backend" \
        "$OUTDIR/$label.$backend.json"
    )
  done

  if [ -s "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

# Head: current working tree (includes uncommitted changes).
bench_at "$ROOT" head

# Base: main, isolated in a worktree.
git -C "$ROOT" worktree add "$WORKTREE" main
bench_at "$WORKTREE" base

# Diff per backend. compare-bench exits non-zero on regression; surface that
# if any backend regresses, but still run all comparisons first so the user
# sees the full picture.
overall_status=0
for backend in $BACKENDS; do
  echo
  echo "=== compare: $backend ==="
  if ! bun run "$PKG/bench/compare-bench.ts" \
    "$OUTDIR/base.$backend.json" \
    "$OUTDIR/head.$backend.json" \
    "$@"; then
    overall_status=1
  fi
done
exit $overall_status
