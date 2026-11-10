// zarrita.js side of the benchmark; mirrors bench/src/main.rs in niivue/zarrita-rs.
// Usage: node bench.mjs <dataset dir> [iters]
// IMPL=zarrita (default) or IMPL=zarrita-rs
const IMPL = process.env.IMPL ?? 'zarrita'
const zarr = await import(IMPL === 'zarrita' ? 'zarrita' : '@niivue/zarrita-rs')
zarr.configureWasm?.({ gzip: 'wasm' }) // measure wasm gzip decoding too

import { performance } from 'node:perf_hooks'
import FileSystemStore from '@zarrita/storage/fs'

const [, , dir, itersArg] = process.argv
const iters = Number(itersArg ?? 10)
const datasets = [
  'raw_c64',
  'gzip_c64',
  'zstd_c64',
  'blosc_lz4_c64',
  'blosc_lz4_c32',
]
const selections = [
  ['full', null],
  ['roi_160', [zarr.slice(40, 200), zarr.slice(40, 200), zarr.slice(40, 200)]],
  ['slice_axis0', [128, null, null]],
  ['slice_axis2', [null, null, 128]],
]
const median = (v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]

for (const name of datasets) {
  const loc = zarr.root(new FileSystemStore(`${dir}/${name}.zarr`))
  const tOpen = []
  for (let i = 0; i < iters; i++) {
    const t = performance.now()
    await zarr.open.v3(loc, { kind: 'array' })
    tOpen.push(performance.now() - t)
  }
  console.log(
    JSON.stringify({
      impl: IMPL === 'zarrita' ? 'js' : 'js-wasm',
      dataset: name,
      read: 'open',
      ms: median(tOpen),
    }),
  )
  const arr = await zarr.open.v3(loc, { kind: 'array' })
  for (const [selName, sel] of selections) {
    const times = []
    let checksum = 0
    for (let i = 0; i < iters + 2; i++) {
      const t = performance.now()
      const out = await zarr.get(arr, sel)
      const ms = performance.now() - t
      if (i >= 2) times.push(ms)
      checksum = 0
      for (const v of out.data) checksum += v
    }
    console.log(
      JSON.stringify({
        impl: IMPL === 'zarrita' ? 'js' : 'js-wasm',
        dataset: name,
        read: selName,
        ms: median(times),
        checksum,
      }),
    )
  }
}
