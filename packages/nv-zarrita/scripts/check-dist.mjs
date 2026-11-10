// Smoke-test the built entries (dist/ and dist/inline/) against the fixtures:
// every array must read the same through both as through the source tests'
// reference, zarrita.js's own codecs (`configureWasm({ enabled: false })`).
// Usage: node scripts/check-dist.mjs   (after `pnpm build`)
import { readdirSync } from 'node:fs'
import FileSystemStore from '@zarrita/storage/fs'

const full = await import('../dist/index.js')
const inline = await import('../dist/inline/index.js')
const root = new URL('../fixtures/v3/data.zarr/', import.meta.url).pathname

async function read(zarr, name) {
  try {
    const arr = await zarr.open.v3(
      zarr.root(new FileSystemStore(root)).resolve(name),
      { kind: 'array' },
    )
    const r = await zarr.get(arr)
    return JSON.stringify([
      r.shape,
      r.stride,
      Array.from(r.data, (v) => String(v)),
    ])
  } catch (e) {
    return `error ${e.name}`
  }
}

const names = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const failures = []
full.configureWasm({ enabled: false })
const reference = Object.fromEntries(
  await Promise.all(names.map(async (n) => [n, await read(full, n)])),
)
full.configureWasm({ enabled: true, gzip: 'wasm' })
inline.configureWasm({ gzip: 'wasm' })
for (const n of names) {
  const want = reference[n]
  for (const [label, lib] of [
    ['full', full],
    ['inline', inline],
  ]) {
    const got = await read(lib, n)
    if (got !== want)
      failures.push(
        `${label} ${n}: ${got.slice(0, 80)} != ${want.slice(0, 80)}`,
      )
  }
}
// Expected differences in the inline entry: no standalone lz4 (no fallback).
const unexpected = failures.filter((f) => !/^inline .*lz4/.test(f))
const expected = failures.length - unexpected.length
full.terminateWasmWorkers()
if (unexpected.length) {
  console.error(unexpected.join('\n'))
  process.exit(1)
}
console.log(
  `check-dist: ${names.length} v3 fixtures match zarrita.js in dist/ and dist/inline/` +
    (expected
      ? ` (inline: ${expected} standalone-lz4 array unsupported, as intended)`
      : ''),
)
