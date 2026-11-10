# Porting status

Upstream: zarrita.js @ `916c72316573d0fc22eaf37c7fce9d0e8e54c4b0` (2026-10-14), ~7k lines of TS.

## Design decisions

- **Async only.** TS has sync and async store variants; in Rust every store implements async traits
  (native `async fn` in traits, `Send` futures). Sync backends return ready futures.
  Runtime-agnostic core; `tokio` only for `FileSystemStore`.
- **Missing key = `Ok(None)`**, matching TS `undefined`. Errors are reserved for real failures.
- **Errors** are one `zarrita::Error` enum mirroring the TS tagged classes (`NotFound`,
  `InvalidMetadata`, `UnknownCodec`, `CodecPipeline`, `InvalidSelection`, `Unsupported`).
  Added `Corrupt`: chunk bytes that fail to decode (truncated, bad checksum) are
  reported as such, never as `Unsupported`, so callers do not retry with a
  different decoder.
- **Data types** are a runtime `DataType` enum. Typed access (`Array<T>`) will come later via a
  `Element` trait for `i8..u64, f16, f32, f64, bool, String`.
- **Extensions** (`withByteCaching`, `withConsolidatedMetadata`, `withRangeCoalescing`) become
  wrapper stores that implement `Readable`, instead of the TS proxy/`defineStoreExtension` approach.

## Checklist

### @zarrita/storage -> `zarrita-storage`
- [x] `types.ts` (traits, `AbsolutePath`, `RangeQuery`)
- [x] `util.ts` (`resolveUri`)
- [x] in-memory `Map` -> `MemoryStore`
- [x] `fs.ts` -> `FileSystemStore`
- [x] `fetch.ts` -> `FetchStore` (basic; no custom fetch handler hook yet)
- [ ] `zip.ts` -> `ZipFileStore`
- [ ] `ref.ts` -> `ReferenceStore` (kerchunk refs)

### zarrita -> `zarrita`
- [x] `errors.ts`
- [x] `metadata.ts` (serde types; all fixtures parse)
- [x] dtype parsing from `util.ts`
- [x] `util.ts`: strides, chunk keys, v2 -> v3 metadata, fill values (no fixedscaleoffset yet)
- [ ] `typedarray.ts` (Bool / ByteString / UnicodeString arrays). Bool and fixed-width strings can be read as raw `u8`/`u32`.
- [x] `codecs.ts` pipeline and registry (`register_codec`)
- [x] codecs: `bytes`, `transpose`, `gzip`, `zlib`, `zstd`, `blosc` (incl. its internal lz4), `shuffle`, `delta`, `crc32c`
- [x] `sharding_indexed` reads (`sharding.rs`): index at start or end, `bytes`/`crc32c` index codecs, range reads of single inner chunks, per-shard index cache
- [-] standalone numcodecs `lz4`: dropped on purpose (legacy format); zarrita-wasm falls back to zarrita.js for it
- [ ] codecs: `vlen-utf8`, `json2`, `bitround`, `scale_offset`, `cast_value`
- [x] `hierarchy.ts`, `open.ts` (v3, then v2 fallback)
- [x] `create.ts` (v3 arrays and groups) plus `Array::set_chunk` for whole-chunk writes
- [x] `indexing/*`: `slice`, `get` (plus a rayon-parallel `get_par`)
- [ ] `indexing/set.ts` (partial-chunk `set`)
- [ ] `extension/*` (caching, consolidation, range coalescing)

Conformance: `crates/zarrita/tests/golden.rs` compares full reads of every fixture
array against zarrita.js output (`tests/golden.json`, from `bench/js/golden.mjs`).
58 of 61 numeric fixtures match byte for byte. The other 3 need bitround,
fixedscaleoffset, or standalone lz4 (dropped).

Note: zarrita.js returns transposed arrays with matching non-C strides; zarrita-rs
always returns C-order output.

### @zarrita/ndarray -> `zarrita-ndarray`
- [ ] everything

## WebAssembly

- `native-blosc` (default) links c-blosc. Without it (as in wasm builds), a
  pure-Rust Blosc1 decoder is used (`codecs/blosc_rs.rs`), tested against
  c-blosc on about 5,000 compressor/shuffle/size combinations. Its
  bit-unshuffle transposes 8x8 bit blocks a u64 at a time, which made
  blosc+bitshuffle chunks decode about 6x faster than a bit-by-bit loop.
- `crates/zarrita-wasm` exposes the codec pipeline over a small C ABI. It
  builds `zarrita` without the `encode` feature (default on), so compressors
  are left out, and zstd without its legacy (pre-1.0) formats. That took the
  module from 1,067 KB to 406 KB (166 KB gzip) at the same decode speed.
  `opt-level = "s"`/`"z"` and wasm-opt shrink it 5-25% more but slow lz4/blosc
  decoding 2-6x, so the build stays at `-O3`.
- `js/zarrita-wasm` is the drop-in JS package (see its README).
- Building it needs the `wasm32-unknown-unknown` target. In the cloud sandbox,
  rustup's server was blocked, so the matching rust-std came from conda-forge
  (`rust-std-wasm32-unknown-unknown`, same rustc commit). On a normal machine,
  `rustup target add wasm32-unknown-unknown` is enough.

## Suggested next steps
1. partial-chunk `set` and sharded writes
2. bool and string arrays
3. extensions (consolidated metadata first)

See `bench/README.md` for performance vs zarrita.js.
