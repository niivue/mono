#!/usr/bin/env bash
# Bench the current working tree vs main, locally.
#
# Usage: bun run bench:compare [-- --warn-pct=N --fail-pct=N --noise-ms=N]
#
# Refuses to run while on main. Builds examples (perf flavor) on both sides,
# starts a vite preview, runs the headless bench, and diffs the results.
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
URL_PARAMS="autorun=1&renderer=1&compute=1&sweeps=0&tract=0&frames=${FRAMES}&computeIter=${COMPUTE_ITER}"

bench_at() {
  local dir="$1"
  local label="$2"
  echo
  echo "=== bench: $label ($dir) ==="

  if [ "$label" = "base" ]; then
    # Worktree starts without node_modules.
    (cd "$dir" && bun install --frozen-lockfile)
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

  (
    cd "$dir/packages/niivue"
    bun run bench \
      "http://localhost:$PORT/examples/benchmark.html?$URL_PARAMS" \
      "$OUTDIR/$label.json"
  )

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

# Diff. compare-bench exits non-zero on regression; surface that.
bun run "$PKG/bench/compare-bench.ts" \
  "$OUTDIR/base.json" \
  "$OUTDIR/head.json" \
  "$@"
