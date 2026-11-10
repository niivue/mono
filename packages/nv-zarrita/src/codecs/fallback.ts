// zarrita.js's numcodecs-based codecs, kept as fallbacks for what the wasm
// core does not do (writing blosc/zstd/lz4, blosc+snappy, `enabled: false`).
// The `inline` build replaces this module with one that has no fallbacks, so
// it does not pull in numcodecs.

export const blosc = () => import('numcodecs/blosc').then((m) => m.default)
export const lz4 = () => import('numcodecs/lz4').then((m) => m.default)
export const zstd = () => import('numcodecs/zstd').then((m) => m.default)
