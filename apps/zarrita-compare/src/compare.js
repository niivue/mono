// Side-by-side comparison page for real (remote) Zarr data:
// zarrita.js vs zarrita-rs (copy) vs zarrita-rs (shared output).

import * as zw from '@niivue/zarrita-rs'
import * as zjs from 'zarrita'

const $ = (id) => document.getElementById(id)
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

function selection(shape, kind) {
  const n = shape.length
  const mid = (i) => Math.floor(shape[i] / 2)
  if (kind === 'full') return null
  if (kind === 'plane-z')
    return shape.map((_, i) => (i < n - 2 ? mid(i) : null))
  // plane-x: middle of leading dims and of the last axis
  return shape.map((_, i) => (i < n - 3 || i === n - 1 ? mid(i) : null))
}

async function timeImpl(label, zarr, url, path, kind, iters, shared) {
  if (zarr.configureWasm)
    zarr.configureWasm({ sharedOutput: shared, gzip: 'wasm' })
  const store = new zarr.FetchStore(url)
  const node = await zarr.open(zarr.root(store).resolve(path), {
    kind: 'array',
  })
  const sel = selection(node.shape, kind)
  const times = []
  let checksum = 0
  let shape
  for (let i = 0; i < iters + 1; i++) {
    const t = performance.now()
    const res = await zarr.get(node, sel)
    const ms = performance.now() - t
    if (i > 0) times.push(ms) // first read warms the code paths
    checksum = 0
    for (let j = 0; j < res.data.length; j += 97)
      checksum += Number(res.data[j])
    shape = res.shape
  }
  return {
    label,
    ms: median(times),
    min: Math.min(...times),
    checksum,
    shape,
    dtype: node.dtype,
    chunks: node.chunks,
  }
}

async function run() {
  const url = $('url').value.trim()
  const path = $('path').value.trim()
  const kind = $('sel').value
  const iters = Number($('iters').value)
  const out = $('out')
  out.textContent = 'running...'
  const rows = []
  try {
    const impls = [
      ['zarrita.js', zjs, false],
      ['zarrita-rs', zw, false],
    ]
    if (crossOriginIsolated) impls.push(['zarrita-rs (shared)', zw, true])
    for (const [label, lib, shared] of impls) {
      rows.push(await timeImpl(label, lib, url, path, kind, iters, shared))
      render(rows)
    }
  } catch (e) {
    out.textContent = `error: ${e?.message ?? e}`
    console.error(e)
  }
}

function render(rows) {
  const base = rows[0].ms
  const r0 = rows[0]
  $('out').innerHTML =
    `<p>dtype ${r0.dtype}, chunks [${r0.chunks}], result shape [${r0.shape}]` +
    `${crossOriginIsolated ? '' : ' (page not cross-origin isolated: shared mode skipped)'}</p>` +
    '<table><tr><th>implementation</th><th>median ms</th><th>min ms</th><th>speedup</th><th>checksum</th></tr>' +
    rows
      .map(
        (r) =>
          `<tr><td>${r.label}</td><td>${r.ms.toFixed(0)}</td><td>${r.min.toFixed(0)}</td>` +
          `<td>${(base / r.ms).toFixed(2)}x</td><td>${r.checksum === r0.checksum ? 'match' : 'MISMATCH'}</td></tr>`,
      )
      .join('') +
    '</table>'
}

$('run').onclick = run
