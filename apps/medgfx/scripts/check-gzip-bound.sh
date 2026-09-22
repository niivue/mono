#!/usr/bin/env bash
# Build a gzip bomb, then assert GzipPeek refuses it under every filename.
#
# ponytail: the bomb is generated, not committed — it is 400 KB of nothing and
# `python3 -c` builds it in under a second.
set -euo pipefail
cd "$(dirname "$0")/.."

# The "a real volume is still accepted" assertion is worthless if the sample is
# a Git LFS pointer — a pointer is not gzip, so it would pass vacuously. Fail
# loudly instead.
if [ "$(head -c 2 medgfx/mni152.nii.gz | xxd -p)" != "1f8b" ]; then
  echo "error: medgfx/mni152.nii.gz is not gzip (Git LFS pointer?). Run: git lfs pull" >&2
  exit 1
fi

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
# A valid 4D NIfTI-1 header in front of the bomb, under a bare `.nii` name --
# the shape that slipped past a header-first budget during review.
python3 -c "
import gzip, struct
nx,ny,nz,nt = 104,104,72,400
h = bytearray(352)
struct.pack_into('<i', h, 0, 348)
struct.pack_into('<8h', h, 40, 4, nx, ny, nz, nt, 1, 1, 1)
struct.pack_into('<h', h, 70, 512); struct.pack_into('<h', h, 72, 16)
struct.pack_into('<f', h, 108, 352)
h[344:348] = b'n+1\\0'
with gzip.open('$DIR/bomb4d.nii','wb',compresslevel=1) as f:
    f.write(bytes(h))
    for _ in range(nt): f.write(bytes(nx*ny*nz*2))
"

# A gzip whose FEXTRA field runs past the 64 KiB header window. `deflateOffset`
# returns nil for this AND for "not gzip", and conflating the two once let a
# 1.1 MB file inflating to 1 GiB through in 0.000 s. The `looksGzip` fail-closed
# branch is what tells them apart; delete it and this case flips to accept.
python3 -c "
import struct
xlen = 65535
hdr = b'\\x1f\\x8b\\x08\\x04' + b'\\0'*6 + struct.pack('<H', xlen) + b'\\0'*xlen
open('$DIR/fextra.nii','wb').write(hdr + b'\\0'*64)
"

out=$(mktemp -d)/check
trap 'rm -rf "$(dirname "$out")"' EXIT
swiftc -o "$out" QuickLookPreview/*.swift scripts/check-gzip-bound.swift
"$out"
