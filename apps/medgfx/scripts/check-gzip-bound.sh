#!/usr/bin/env bash
# Build a gzip bomb, then assert GzipPeek refuses it under every filename.
#
# ponytail: the bomb is generated, not committed — it is 400 KB of nothing and
# `python3 -c` builds it in under a second.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=/tmp/medgfx-bomb
mkdir -p "$DIR"
if [ ! -f "$DIR/bomb.gz" ]; then
  echo "Building a 400 MB -> 400 KB gzip bomb..."
  python3 -c "
import gzip
with gzip.open('$DIR/bomb.gz','wb',compresslevel=9) as f:
    chunk = b'\0' * (1024*1024)
    for _ in range(400): f.write(chunk)
"
fi
# Same bytes, names that route to different NiiVue readers.
cp -f "$DIR/bomb.gz" "$DIR/bomb.nii"
cp -f "$DIR/bomb.gz" "$DIR/bomb.mz3"

out=$(mktemp -d)/check
trap 'rm -rf "$(dirname "$out")"' EXIT
swiftc -o "$out" QuickLookPreview/GzipPeek.swift scripts/check-gzip-bound.swift
"$out"
