# zarrita-wasm

A drop-in replacement for [zarrita.js](https://github.com/manzt/zarrita.js) that
decodes chunks with Rust compiled to WebAssembly, in a pool of Web Workers
(browsers) or `worker_threads` (Node).

```diff
- import * as zarr from "zarrita";
+ import * as zarr from "zarrita-wasm";
```

Or keep your imports and alias the package: `"zarrita": "npm:zarrita-wasm@^0.1.0"`.

## How it works

The public API, types, stores and store extensions are zarrita.js 0.7.5's own
code. Only two internals change:

1. **Chunk decoding.** When an array's codec chain contains a compressor the
   wasm core supports (gzip, zlib, zstd, blosc, optionally with bytes,
   transpose, shuffle, delta and crc32c), `decode` runs in wasm (for
   gzip/zlib-only arrays, see the `gzip` option below). Chunks larger
   than 64 KiB decoded go to a worker; smaller ones decode on the calling
   thread. Everything else (sharding, strings, bitround, uncompressed arrays,
   writes) uses zarrita.js's code unchanged.
2. **Copying chunks into the output** uses a faster typed-array kernel.

Codecs you replace via `zarr.registry.set(...)` are always respected: the wasm
path only runs for codecs whose registry entry is still the built-in one. No
`SharedArrayBuffer` or cross-origin isolation is needed.

### Shared output (optional, faster)

When the output is backed by a `SharedArrayBuffer`, workers decode and write
their part of the result directly into it, so the main thread does no
decoding or copying at all. This happens when:

- you pass zarrita.js's existing option `zarr.get(arr, sel, { useSharedArrayBuffer: true })`, or
- you call `configureWasm({ sharedOutput: true })` and the page is
  cross-origin isolated (COOP `same-origin` plus COEP `require-corp` or
  `credentialless`). In Node it always applies.

Results then have `data.buffer instanceof SharedArrayBuffer`. Typed arrays
over shared memory work with WebGL/WebGPU uploads and most APIs, but a few
(for example `TextDecoder.decode`) reject them, which is why it is opt-in.

## Download size

Measured with esbuild code splitting (as Vite/webpack apps get), gzip -9:

| What a page downloads | zarrita.js | zarrita-wasm |
|---|---:|---:|
| Library core | 14.5 KB | 18 KB |
| Reading blosc data | + 204 KB (numcodecs blosc) | + 166 KB (`zarrita.wasm`, all codecs) |
| Reading zstd data | + 241 KB (numcodecs zstd) | + 166 KB |
| Reading standalone-lz4 data (legacy) | + 16 KB | + 16 KB (zarrita.js decoder) |
| Reading gzip/zlib data | + 0 (browser built-in) | + 0 by default (see `gzip` option) |
| Uncompressed data | + 0 | + 0 (wasm is not loaded) |

`zarrita.wasm` is 405 KB raw, 166 KB gzip, 137 KB brotli, and is fetched once
and shared by all workers. It contains decoders only. Of that, zstd is about
41 KB gzip; JSON parsing of codec configs and zlib-rs make up most of the rest.
By default (`gzip: "auto"`), arrays compressed only with gzip or zlib use the
browser's built-in decoder, as zarrita.js does, unless `zarrita.wasm` is
already loaded because another array needed it; then they decode in wasm
workers for free. `gzip: "wasm"` always uses wasm (about 1.8x faster decoding
for a 166 KB download); `gzip: "native"` never does.
zarrita.js's codec modules stay in the package as fallbacks and are only
fetched if the JS path is used.

## Extra API

```ts
zarr.configureWasm({
  enabled: true,        // false = behave exactly like zarrita.js
  sharedOutput: false,  // see "Shared output" above
  gzip: "auto",         // "auto" | "wasm" | "native", see "Download size" above
  workers: 4,           // default: hardware threads, max 8; 0 = no workers
  minWorkerBytes: 65536,
  wasmUrl, workerUrl,   // override asset locations (e.g. a CDN)
});
zarr.terminateWasmWorkers();
```

## `zarrita-wasm/inline`

A second entry for hosts that already decode in their own workers, or that
bundle into one file or an inline worker (NiiVue's OME-Zarr chunk workers are
both):

```ts
import * as zarr from "zarrita-wasm/inline";
```

Same API, but the wasm module is embedded in the JavaScript as base64 (in a
lazily imported chunk, about 220 KB gzip), there is no worker pool, the code
never refers to its own URL, and there is no numcodecs fallback. blosc and zstd
stages that cannot take the whole-pipeline fast path (compressed string arrays,
sharding indexes) still decode in wasm; writing blosc/zstd and standalone lz4
are not available. `pnpm test:dist` checks both entries against zarrita.js.

## Install

Until it is published to npm, install the packed tarball:

```sh
npm install /path/to/zarrita-wasm-0.1.0.tgz
```

## Bundlers

The package loads `wasm/worker.js` and `wasm/zarrita.wasm` with
`new URL(..., import.meta.url)`. Vite production builds pick them up as
assets automatically (checked with Vite 6). webpack 5 and Parcel support the
same pattern but have not been tested yet.

Vite's **dev server** pre-bundles dependencies, which breaks those URLs. Exclude
the package (checked with Vite 6):

```js
// vite.config.js
export default { optimizeDeps: { exclude: ["zarrita-wasm"] } };
```

Without it you get an error that says so. Other setups can pass `workerUrl`
and `wasmUrl` to `configureWasm`.

## Building

```sh
pnpm install
pnpm run build:wasm   # needs the wasm32-unknown-unknown Rust target and clang (for zstd)
pnpm run build
pnpm test             # zarrita.js's own test suite plus wasm-path tests
```

## Status

- All 764 zarrita.js 0.7.5 tests pass.
- Every fixture array, plus about 300 random slice/step/integer selections,
  reads identically to zarrita.js in all modes (main thread, workers, shared
  output on main thread and in workers).
- The standalone numcodecs `lz4` codec is deliberately not in the wasm core
  (a legacy format); such arrays still read through zarrita.js's own decoder,
  so the drop-in API is unchanged. Blosc's internal lz4 is fully supported.
- Not yet: sharded arrays use the copying path (inner chunks still decode in
  wasm); blosc+snappy falls back to JS.

## Trying it on your own data

`bench/js/browser` has a comparison page that reads any CORS-enabled Zarr URL
with zarrita.js, zarrita-wasm and zarrita-wasm with shared output:

```sh
cd bench/js && npm install && cd browser && node build.mjs && node serve.mjs
# open http://localhost:8080/wasm/compare.html
```
