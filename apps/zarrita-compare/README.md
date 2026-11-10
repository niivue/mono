# zarrita-compare

Side-by-side comparison of [zarrita.js](https://github.com/manzt/zarrita.js) and
`@niivue/zarrita-rs` (zarrita.js with Rust/WebAssembly codecs). Each run reads
the same array with both libraries and checks that the checksums match.

## In the browser, on real data

```sh
bunx nx dev zarrita-compare
```

Enter a Zarr store URL (the server must allow CORS) and an array path, pick a
selection, and press Run. The table shows median and minimum read times, the
speedup over zarrita.js, and whether each checksum matches. The dev server is
cross-origin isolated, so the page also times zarrita-rs's `sharedOutput`
mode, where workers write straight into the result.

## In Node, on generated data

```sh
ZARRITA_RS=~/src/zarrita-rs bunx nx bench zarrita-compare   # or: bench/run.sh [data dir] [iters]
```

Needs a Rust toolchain and a [niivue/zarrita-rs](https://github.com/niivue/zarrita-rs)
checkout in `ZARRITA_RS`. Its Rust benchmark (`bench/`) writes a 256x256x256
int16 volume as Zarr v3 in five variants (raw, gzip, zstd, blosc-lz4 with 64^3
and 32^3 chunks), then times `open`, the full array, a 160^3 sub-volume and two
orthogonal planes with:

- `js`: zarrita.js, `FileSystemStore`
- `js-wasm`: `@niivue/zarrita-rs`, same store, decoding in WebAssembly workers
- `rust` / `rust-par`: the native Rust crate, single-threaded and rayon-parallel

and prints one table with speedups over zarrita.js.

On an Apple Silicon Mac (2026-11-10, 5 iterations) every checksum matched and
zarrita-rs read 1.5-10.5x faster than zarrita.js on compressed data (gzip
1.5-2.8x, zstd 6-8.6x, blosc-lz4 2.6-10.5x) and up to 9.4x faster on strided
raw planes. Earlier runs in a 2 vCPU sandbox show that over a network with
20 ms per request the two tie: request round trips dominate, not decoding.
Rerun on your hardware before drawing conclusions.
