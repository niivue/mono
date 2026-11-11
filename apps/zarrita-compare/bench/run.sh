#!/usr/bin/env bash
# Side by side in Node: native Rust, zarrita.js and @niivue/zarrita-rs on the same data.
# Usage: ZARRITA_RS=<niivue/zarrita-rs checkout> apps/zarrita-compare/bench/run.sh [data dir] [iters]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
zrs="${ZARRITA_RS:?set ZARRITA_RS to a niivue/zarrita-rs checkout (its bench crate writes and times the data)}"
data="${1:-$here/data}"
iters="${2:-10}"
cargo build --release --manifest-path "$zrs/Cargo.toml" -p zarrita-bench
bench="$zrs/target/release/zarrita-bench"
[ -d "$data/raw_c64.zarr" ] || "$bench" gen "$data"
"$bench" run "$data" "$iters" > "$here/results-rust.jsonl"
node "$here/bench.mjs" "$data" "$iters" > "$here/results-js.jsonl"
IMPL=zarrita-rs node "$here/bench.mjs" "$data" "$iters" > "$here/results-js-wasm.jsonl"
python3 "$here/compare.py" --impls js,js-wasm,rust,rust-par "$here/results-js.jsonl" "$here/results-js-wasm.jsonl" "$here/results-rust.jsonl"
