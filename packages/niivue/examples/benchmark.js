/**
 * NiiVue benchmark harness (mono `packages/niivue` flavor).
 *
 * Measures:
 *  1. Renderer frame-time scenarios against the live WebGPU backend.
 *     Each scenario reports a CPU vs GPU-submit split via the
 *     `performance.mark`/`measure` instrumentation in `src/view/NVPerfMarks.ts`,
 *     consumed through a `PerformanceObserver`.
 *  2. Compute function scenarios (vox2mm, generateNormals, encodeRLE, etc.).
 *     This package is JS-only — there's no WASM toggle.
 *  3. Scaling sweeps (opt-in checkbox):
 *      - Tile-count sweep: 1..16 mosaic tiles → frame-time slope/intercept
 *      - Mesh-size sweep: [1, 4, 16, 64] meshes × [10K, 100K, 1M] verts → mean
 *        frame-time and per-frame uniform-write byte volume
 *  4. Tract regeneration (opt-in): synthetic tracts of 1K/10K/50K streamlines
 *     fed through `tessellate()`; results report ms/1k-streamlines.
 *  5. Bundle sizes (auto): if `examples/entry-sizes.json` is present
 *     (produced by `scripts/report-entry-sizes.js` after `bun run build`),
 *     it is included in the JSON output and the markdown report.
 *
 * Exports results as JSON (schema `niivue-benchmark-v1`, top-level keys
 * `env`/`renderer`/`compute`/`sweeps`/`tract`/`bundleSizes`) and a
 * copy-pasteable markdown table. Two runs can be diffed with
 * `node benchmarks/diff-runs.mjs a.json b.json`.
 */

import { mat4 } from 'gl-matrix'
import { decodeRLE, encodeRLE } from '../src/drawing/rle.ts'
import NiiVue from '../src/index.ts'
import {
  calculateMvpMatrix,
  calculateMvpMatrix2D,
  cart2sphDeg,
  deg2rad,
  vox2mm,
} from '../src/math/NVTransforms.ts'
import { createMesh, generateNormals } from '../src/mesh/NVMesh.ts'
import { tessellate as tractTessellate } from '../src/mesh/tracts/index.ts'
import {
  consumeFrameStats,
  isPerfBuild,
  setPerfMarksEnabled,
} from '../src/view/NVPerfMarks.ts'
import { reorientRGBA } from '../src/volume/utils.ts'
import { MESH_UNIFORM_SIZE } from '../src/wgpu/mesh.ts'

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const canvasA = document.getElementById('canvasA')
const resultsDiv = document.getElementById('results')
const statusEl = document.getElementById('statusText')
const mdOut = document.getElementById('markdownOutput')
const runBtn = document.getElementById('runBtn')
const abortBtn = document.getElementById('abortBtn')
const exportJsonBtn = document.getElementById('exportJsonBtn')
const exportMdBtn = document.getElementById('exportMdBtn')
const copyMdBtn = document.getElementById('copyMdBtn')

function setStatus(msg) {
  statusEl.textContent = msg
}

// Cooperative-abort state. Long render loops yield via rAF every
// YIELD_EVERY frames so the compositor can paint and the abort click
// can register; on resume they call checkAbort() to bail.
const ABORT_ERROR = 'aborted'
const YIELD_EVERY = 30
let _aborted = false
function checkAbort() {
  if (_aborted) throw new Error(ABORT_ERROR)
}
async function yieldAndCheck() {
  await new Promise((r) => requestAnimationFrame(r))
  checkAbort()
}
abortBtn.onclick = () => {
  _aborted = true
  setStatus('Aborting...')
  abortBtn.disabled = true
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function benchSamples(fn, n, warmup = 5) {
  for (let i = 0; i < warmup; i++) fn()
  const samples = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    samples[i] = performance.now() - t0
  }
  return samples
}

function summarize(samples) {
  const n = samples.length
  if (n === 0)
    return {
      n: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      p95: 0,
      p99: 0,
      stddev: 0,
    }
  const sorted = Array.from(samples).sort((a, b) => a - b)
  const sum = sorted.reduce((s, v) => s + v, 0)
  const mean = sum / n
  const median = sorted[Math.floor(n / 2)]
  const min = sorted[0]
  const max = sorted[n - 1]
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))]
  const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))]
  const variance = sorted.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n
  const stddev = Math.sqrt(variance)
  return { n, mean, median, min, max, p95, p99, stddev }
}

const fmt = (v) => (v == null ? '—' : v.toFixed(3))

// ---------------------------------------------------------------------------
// Environment capture
// ---------------------------------------------------------------------------

async function captureEnv() {
  const urlParams = new URLSearchParams(window.location.search)
  const env = {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    paced: urlParams.get('paced') === '1',
    perfBuild: isPerfBuild(),
  }
  const labelParam = urlParams.get('label')
  if (labelParam) env.label = labelParam
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter()
      if (adapter?.info) {
        env.gpu = {
          vendor: adapter.info.vendor || '',
          architecture: adapter.info.architecture || '',
          device: adapter.info.device || '',
          description: adapter.info.description || '',
        }
      }
    }
  } catch (e) {
    env.gpu = { error: String(e) }
  }
  return env
}

// ---------------------------------------------------------------------------
// Compute scenarios
// ---------------------------------------------------------------------------

function computeScenarios(iter) {
  const mtx = mat4.create()
  mat4.fromScaling(mtx, [2, 2, 2])
  const xyz = [45, 54, 45]
  const mn = [-90, -90, -90]
  const mx = [90, 90, 90]

  const makeMesh = (numVerts) => {
    const pts = new Float32Array(numVerts * 3)
    for (let i = 0; i < pts.length; i++) pts[i] = Math.random() * 100
    const tris = new Uint32Array((numVerts - 2) * 3)
    for (let i = 0; i < numVerts - 2; i++) {
      tris[i * 3] = i
      tris[i * 3 + 1] = i + 1
      tris[i * 3 + 2] = i + 2
    }
    return { pts, tris }
  }

  const makeRleData = (mb) => {
    const data = new Uint8Array(mb * 1024 * 1024)
    for (let i = 0; i < data.length; i += 37) data[i] = 1
    return data
  }

  const makeRgba = (dim) => {
    const raw = new Uint8Array(dim * dim * dim * 4)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 17) & 0xff
    return raw
  }

  const meshSm = makeMesh(10_000)
  const meshMd = makeMesh(100_000)
  const meshLg = makeMesh(1_000_000)

  const rle1 = makeRleData(1)
  const rle4 = makeRleData(4)
  const rle16 = makeRleData(16)

  const rgba128 = makeRgba(128)
  const rgba256 = makeRgba(256)

  const rle1Enc = encodeRLE(rle1)
  const rle4Enc = encodeRLE(rle4)
  const rle16Enc = encodeRLE(rle16)

  const dimsRAS = [0, 128, 128, 128]
  const img2RASstart = [0, 0, 0]
  const img2RASstep = [1, 128, 128 * 128]
  const dimsRAS256 = [0, 256, 256, 256]
  const img2RASstart256 = [0, 0, 0]
  const img2RASstep256 = [1, 256, 256 * 256]

  return [
    {
      name: 'vox2mm',
      category: 'computation',
      dataSize: '1 call',
      iter: iter * 100,
      fn: () => vox2mm(null, xyz, mtx),
    },
    {
      name: 'cart2sphDeg',
      category: 'computation',
      dataSize: '1 call',
      iter: iter * 100,
      fn: () => cart2sphDeg(1, 2, 3),
    },
    {
      name: 'deg2rad',
      category: 'computation',
      dataSize: '1 call',
      iter: iter * 1000,
      fn: () => deg2rad(45),
    },
    {
      name: 'calculateMvpMatrix',
      category: 'computation',
      dataSize: '3D perspective',
      iter: iter * 10,
      fn: () => calculateMvpMatrix([0, 0, 800, 600], 110, 10, [0, 0, 0], 1, 1),
    },
    {
      name: 'calculateMvpMatrix2D',
      category: 'computation',
      dataSize: '400x400',
      iter: iter * 10,
      fn: () =>
        calculateMvpMatrix2D(
          [0, 0, 400, 400],
          mn,
          mx,
          Infinity,
          undefined,
          0,
          0,
          false,
        ),
    },
    {
      name: 'calculateMvpMatrix2D',
      category: 'computation',
      dataSize: '1024x768',
      iter: iter * 10,
      fn: () =>
        calculateMvpMatrix2D(
          [0, 0, 1024, 768],
          mn,
          mx,
          Infinity,
          undefined,
          0,
          0,
          false,
        ),
    },
    {
      name: 'calculateMvpMatrix2D',
      category: 'computation',
      dataSize: '1920x1080',
      iter: iter * 10,
      fn: () =>
        calculateMvpMatrix2D(
          [0, 0, 1920, 1080],
          mn,
          mx,
          Infinity,
          undefined,
          0,
          0,
          false,
        ),
    },

    {
      name: 'generateNormals',
      category: 'mesh',
      dataSize: '10K verts',
      iter: Math.max(5, Math.floor(iter / 2)),
      fn: () => generateNormals(meshSm.pts, meshSm.tris),
    },
    {
      name: 'generateNormals',
      category: 'mesh',
      dataSize: '100K verts',
      iter: Math.max(5, Math.floor(iter / 10)),
      fn: () => generateNormals(meshMd.pts, meshMd.tris),
    },
    {
      name: 'generateNormals',
      category: 'mesh',
      dataSize: '1M verts',
      iter: Math.max(3, Math.floor(iter / 50)),
      fn: () => generateNormals(meshLg.pts, meshLg.tris),
    },

    {
      name: 'encodeRLE',
      category: 'drawing',
      dataSize: '1 MB',
      iter: Math.max(5, Math.floor(iter / 5)),
      fn: () => encodeRLE(rle1),
    },
    {
      name: 'encodeRLE',
      category: 'drawing',
      dataSize: '4 MB',
      iter: Math.max(5, Math.floor(iter / 20)),
      fn: () => encodeRLE(rle4),
    },
    {
      name: 'encodeRLE',
      category: 'drawing',
      dataSize: '16 MB',
      iter: Math.max(3, Math.floor(iter / 50)),
      fn: () => encodeRLE(rle16),
    },
    {
      name: 'decodeRLE',
      category: 'drawing',
      dataSize: '1 MB',
      iter: Math.max(5, Math.floor(iter / 5)),
      fn: () => decodeRLE(rle1Enc, rle1.length),
    },
    {
      name: 'decodeRLE',
      category: 'drawing',
      dataSize: '4 MB',
      iter: Math.max(5, Math.floor(iter / 20)),
      fn: () => decodeRLE(rle4Enc, rle4.length),
    },
    {
      name: 'decodeRLE',
      category: 'drawing',
      dataSize: '16 MB',
      iter: Math.max(3, Math.floor(iter / 50)),
      fn: () => decodeRLE(rle16Enc, rle16.length),
    },

    {
      name: 'reorientRGBA',
      category: 'volume',
      dataSize: '128³',
      iter: Math.max(5, Math.floor(iter / 10)),
      fn: () => reorientRGBA(rgba128, 4, dimsRAS, img2RASstart, img2RASstep),
    },
    {
      name: 'reorientRGBA',
      category: 'volume',
      dataSize: '256³',
      iter: Math.max(3, Math.floor(iter / 50)),
      fn: () =>
        reorientRGBA(rgba256, 4, dimsRAS256, img2RASstart256, img2RASstep256),
    },
  ]
}

async function runCompute(iter) {
  setStatus('Running compute scenarios...')
  const scenarios = computeScenarios(iter)
  const results = []

  for (const s of scenarios) {
    setStatus(`Compute: ${s.name} (${s.dataSize})...`)
    await new Promise((r) => setTimeout(r, 0))
    checkAbort()
    const samples = benchSamples(s.fn, s.iter, 5)
    const stats = summarize(samples)
    results.push({ ...s, fn: undefined, stats })
  }
  return results
}

// ---------------------------------------------------------------------------
// Renderer scenarios
// ---------------------------------------------------------------------------

const VOL_MNI = [{ url: '/volumes/mni152.nii.gz' }]
const VOL_OVERLAY = [
  { url: '/volumes/mni152.nii.gz' },
  { url: '/volumes/spmMotor.nii.gz', colormap: 'warm', calMin: 2, calMax: 8 },
]
const MESH_BRAIN = [
  { url: '/meshes/BrainMesh_ICBM152.lh.mz3', rgba255: [220, 220, 220, 255] },
]
const MESH_TRACT = [{ url: '/meshes/tract.IFOF_R.trk' }]

async function unloadAll(nv) {
  await nv.removeAllVolumes()
  await nv.removeAllMeshes()
}

async function ensureAssets(nv, { volumes = null, meshes = null } = {}) {
  await unloadAll(nv)
  if (volumes) await nv.loadVolumes(volumes)
  if (meshes) await nv.loadMeshes(meshes)
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  )
}

let _bench_paced = false
function setBenchPaced(value) {
  _bench_paced = value
}

async function _waitGpu(nv) {
  if (!_bench_paced) return
  const dev = nv.view?.device
  if (dev?.queue?.onSubmittedWorkDone) {
    await dev.queue.onSubmittedWorkDone()
  }
}

async function benchRenderFrames(nv, frames, warmup = 20) {
  for (let i = 0; i < warmup; i++) {
    nv.view.render()
    await _waitGpu(nv)
  }
  const samples = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now()
    nv.view.render()
    await _waitGpu(nv)
    samples[i] = performance.now() - t0
    if ((i + 1) % YIELD_EVERY === 0) await yieldAndCheck()
  }
  return samples
}

/**
 * Collect CPU vs submit split timings via the renderer's perf marks.
 * Returns { wall, cpu, submit, frame } each holding one sample per render() call.
 * Falls back to empty arrays if PerformanceObserver isn't available.
 */
async function benchRenderFramesWithSplit(nv, frames, warmup = 20) {
  const cpu = []
  const submit = []
  const frame = []
  const phases = {}
  const recordPhases = (s) => {
    for (const k of Object.keys(s)) {
      if (!phases[k]) phases[k] = []
      phases[k].push(s[k])
    }
  }
  const ingest = (entries) => {
    for (const e of entries) {
      if (e.name === 'niivue:render-cpu') cpu.push(e.duration)
      else if (e.name === 'niivue:render-submit') submit.push(e.duration)
      else if (e.name === 'niivue:render-frame') frame.push(e.duration)
    }
  }
  let observer = null
  if (typeof PerformanceObserver !== 'undefined') {
    observer = new PerformanceObserver((list) => ingest(list.getEntries()))
    try {
      observer.observe({ entryTypes: ['measure'] })
    } catch {
      observer = null
    }
  }
  setPerfMarksEnabled(true)
  for (let i = 0; i < warmup; i++) {
    nv.view.render()
    await _waitGpu(nv)
  }
  if (observer) {
    observer.takeRecords()
    cpu.length = 0
    submit.length = 0
    frame.length = 0
  }
  const wall = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now()
    nv.view.render()
    await _waitGpu(nv)
    wall[i] = performance.now() - t0
    recordPhases(consumeFrameStats())
    if ((i + 1) % YIELD_EVERY === 0) await yieldAndCheck()
  }
  setPerfMarksEnabled(false)
  if (observer) {
    ingest(observer.takeRecords())
    observer.disconnect()
  }
  const phaseArrays = {}
  for (const k of Object.keys(phases))
    phaseArrays[k] = Float64Array.from(phases[k])
  return {
    wall,
    cpu: Float64Array.from(cpu),
    submit: Float64Array.from(submit),
    frame: Float64Array.from(frame),
    phases: phaseArrays,
  }
}

async function rendererScenarios(nv, frames) {
  const scenarios = []

  const run = async (name, setup) => {
    setStatus(`Renderer: ${name}...`)
    checkAbort()
    await setup()
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    )
    checkAbort()
    const split = await benchRenderFramesWithSplit(nv, frames)
    const cpuStats = split.cpu.length ? summarize(split.cpu) : null
    const submitStats = split.submit.length ? summarize(split.submit) : null
    const frameStats = split.frame.length ? summarize(split.frame) : null
    scenarios.push({
      name,
      frames,
      stats: summarize(split.wall),
      cpu: cpuStats,
      submit: submitStats,
      frame: frameStats,
    })
  }

  await run('Clear render', async () => {
    await unloadAll(nv)
    nv.sliceType = 3
    nv.mosaicString = ''
  })

  await run('2D slice A+C+S', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI })
    nv.sliceType = 3
    nv.mosaicString = ''
  })

  await run('Multiplanar A+C+S+R', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI })
    nv.sliceType = 3
    nv.mosaicString = ''
    nv.showRender = 1 // SHOW_RENDER.ALWAYS
  })

  await run('Single axial', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI })
    nv.sliceType = 0
  })

  await run('Mosaic', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI })
    nv.sliceType = 3
    nv.mosaicString = 'A -20 0 20 ; S R X 0 S R X -0'
  })

  await run('3D ray-march', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI })
    nv.mosaicString = ''
    nv.showRender = 0 // SHOW_RENDER.NEVER
    nv.sliceType = 4
  })

  await run('Volume + overlay', async () => {
    await ensureAssets(nv, { volumes: VOL_OVERLAY })
    nv.sliceType = 3
    nv.mosaicString = ''
    nv.showRender = 1
  })

  await run('Mesh only', async () => {
    await ensureAssets(nv, { meshes: MESH_BRAIN })
    nv.sliceType = 4
  })

  await run('Volume + mesh', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI, meshes: MESH_BRAIN })
    nv.sliceType = 4
  })

  await run('Tractography', async () => {
    await ensureAssets(nv, { volumes: VOL_MNI, meshes: MESH_TRACT })
    nv.sliceType = 4
  })

  return scenarios
}

// ---------------------------------------------------------------------------
// Scaling sweeps — tile-count and mesh-size
// ---------------------------------------------------------------------------

const TILE_SWEEP = [
  { tiles: 1, mosaic: 'A 0' },
  { tiles: 2, mosaic: 'A -10 10' },
  { tiles: 4, mosaic: 'A -20 -10 10 20' },
  { tiles: 8, mosaic: 'A -30 -20 -10 0 ; A 10 20 30 40' },
  {
    tiles: 16,
    mosaic:
      'A -40 -30 -20 -10 ; A 0 10 20 30 ; A 40 -50 50 -60 ; A 60 -70 70 80',
  },
]

async function tileSweep(nv, frames) {
  setStatus('Tile-count sweep...')
  await ensureAssets(nv, { volumes: VOL_MNI })
  nv.sliceType = 3
  const rows = []
  for (const cfg of TILE_SWEEP) {
    setStatus(`Tile sweep: ${cfg.tiles} tiles...`)
    await new Promise((r) => setTimeout(r, 0))
    checkAbort()
    nv.mosaicString = cfg.mosaic
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    )
    const samples = await benchRenderFrames(nv, frames)
    rows.push({
      tiles: cfg.tiles,
      mosaic: cfg.mosaic,
      frames,
      stats: summarize(samples),
    })
  }
  // Linear regression of mean frame-time vs tile-count.
  const n = rows.length
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0
  for (const r of rows) {
    const x = r.tiles,
      y = r.stats.mean
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const denom = n * sxx - sx * sx
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  return { rows, slope, intercept }
}

const MESH_SWEEP_COUNTS = [1, 4, 16, 64]
const MESH_SWEEP_SIZES = [
  { label: '10K verts', numVerts: 10_000 },
  { label: '100K verts', numVerts: 100_000 },
  { label: '1M verts', numVerts: 1_000_000 },
]

function makeSyntheticMesh(numVerts, seedOffset = 0) {
  const positions = new Float32Array(numVerts * 3)
  let s = (0x9e3779b1 ^ seedOffset) >>> 0
  for (let i = 0; i < positions.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    positions[i] = ((s & 0xffff) / 0xffff) * 100 - 50
  }
  const triCount = numVerts - 2
  const indices = new Uint32Array(triCount * 3)
  for (let i = 0; i < triCount; i++) {
    indices[i * 3] = i
    indices[i * 3 + 1] = i + 1
    indices[i * 3 + 2] = i + 2
  }
  const colors = new Uint32Array(numVerts).fill(0xffffffff)
  return createMesh(positions, indices, colors, {
    rgba255: [220, 220, 220, 255],
    shaderType: 'phong',
  })
}

async function meshSweep(nv, frames) {
  setStatus('Mesh-size sweep...')
  await unloadAll(nv)
  nv.sliceType = 4 // 3D render
  nv.mosaicString = ''

  const rows = []
  for (const size of MESH_SWEEP_SIZES) {
    for (const count of MESH_SWEEP_COUNTS) {
      const totalVerts = size.numVerts * count
      // Skip combos ≥ 8M vertices total. 16 × 1M (16M) reliably hangs the
      // GPU compositor on Apple integrated GPUs (white-screens the entire
      // browser, not just the tab). 64 × 1M (64M) also trips WebGPU's
      // per-buffer cap with mappedAtCreation=true. The 8M ceiling keeps
      // 4 × 1M and 64 × 100K (6.4M) — enough to characterize per-mesh
      // overhead without putting the system at risk.
      if (totalVerts >= 8_000_000) {
        rows.push({
          size: size.label,
          count,
          totalVerts,
          frames: 0,
          stats: null,
          uniformBytesPerFrame: null,
          skipped: 'too-large',
        })
        continue
      }
      setStatus(`Mesh sweep: ${count} × ${size.label}...`)
      await new Promise((r) => setTimeout(r, 0))
      checkAbort()
      await unloadAll(nv)
      for (let i = 0; i < count; i++) {
        const m = makeSyntheticMesh(size.numVerts, i)
        await nv.addMesh(m)
      }
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      const samples = await benchRenderFrames(nv, frames)
      // Mesh hot-path writes MESH_UNIFORM_SIZE bytes per (tile × mesh).
      // 3D render with no mosaic uses a single render tile.
      const tilesActive = 1
      const uniformBytesPerFrame = tilesActive * count * MESH_UNIFORM_SIZE
      rows.push({
        size: size.label,
        count,
        totalVerts,
        frames,
        stats: summarize(samples),
        uniformBytesPerFrame,
        skipped: null,
      })
    }
  }
  await unloadAll(nv)
  return rows
}

async function runSweeps(nv, frames) {
  let tile = null
  let mesh = null
  try {
    tile = await tileSweep(nv, frames)
  } catch (err) {
    console.error('tile sweep failed:', err)
  }
  try {
    mesh = await meshSweep(nv, frames)
  } catch (err) {
    console.error('mesh sweep failed:', err)
  }
  return { tile, mesh }
}

// ---------------------------------------------------------------------------
// Tract regeneration latency
// ---------------------------------------------------------------------------

function makeSyntheticTract(nStreamlines, pointsPerStreamline) {
  const totalPoints = nStreamlines * pointsPerStreamline
  const vertices = new Float32Array(totalPoints * 3)
  const offsets = new Uint32Array(nStreamlines + 1)
  let s = 0xa5a5a5a5 >>> 0
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s & 0xffffff) / 0xffffff - 0.5
  }
  for (let i = 0; i < nStreamlines; i++) {
    offsets[i] = i * pointsPerStreamline
    let x = rnd() * 80,
      y = rnd() * 80,
      z = rnd() * 80
    for (let p = 0; p < pointsPerStreamline; p++) {
      const idx = (i * pointsPerStreamline + p) * 3
      vertices[idx] = x
      vertices[idx + 1] = y
      vertices[idx + 2] = z
      x += rnd() * 2
      y += rnd() * 2
      z += rnd() * 2
    }
  }
  offsets[nStreamlines] = totalPoints
  return {
    vertices,
    offsets,
    dpv: {},
    dps: {},
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  }
}

const TRACT_REGEN_SCENARIOS = [
  { label: '1K streamlines', nStreamlines: 1_000, pointsPerStreamline: 50 },
  { label: '10K streamlines', nStreamlines: 10_000, pointsPerStreamline: 50 },
  { label: '50K streamlines', nStreamlines: 50_000, pointsPerStreamline: 50 },
]

async function tractRegen(iter = 5) {
  setStatus('Tract regeneration...')
  const results = []
  const baseOptions = {
    fiberRadius: 0.5,
    fiberSides: 7,
    minLength: 0,
    decimation: 1,
    colormap: 'warm',
    colormapNegative: '',
    colorBy: '',
    calMin: 0,
    calMax: 0,
    calMinNeg: 0,
    calMaxNeg: 0,
    fixedColor: [255, 255, 255, 255],
    groupColors: null,
  }
  for (const scn of TRACT_REGEN_SCENARIOS) {
    await new Promise((r) => setTimeout(r, 0))
    checkAbort()
    setStatus(`Tract regen: ${scn.label}...`)
    const data = makeSyntheticTract(scn.nStreamlines, scn.pointsPerStreamline)
    // Warmup
    for (let i = 0; i < 2; i++) tractTessellate(data, { ...baseOptions })
    const samples = new Float64Array(iter)
    for (let i = 0; i < iter; i++) {
      const t0 = performance.now()
      tractTessellate(data, { ...baseOptions })
      samples[i] = performance.now() - t0
    }
    const stats = summarize(samples)
    const msPer1k = (stats.mean / scn.nStreamlines) * 1000
    results.push({
      label: scn.label,
      nStreamlines: scn.nStreamlines,
      pointsPerStreamline: scn.pointsPerStreamline,
      iter,
      stats,
      msPer1kStreamlines: msPer1k,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Bundle sizes (optional, fetched from /examples/entry-sizes.json)
// ---------------------------------------------------------------------------

async function fetchBundleSizes() {
  try {
    const res = await fetch('./entry-sizes.json', { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Rendering the results table
// ---------------------------------------------------------------------------

function renderResultsTable(
  env,
  computeResults,
  rendererResults,
  sweepResults,
  tractResults,
  bundleSizes,
) {
  let html = `<h2>Environment</h2>
<table>
  <tr><th>Timestamp</th><td>${env.timestamp}</td></tr>
  <tr><th>User Agent</th><td>${env.userAgent}</td></tr>
  <tr><th>Platform</th><td>${env.platform}</td></tr>
  <tr><th>GPU</th><td>${env.gpu ? env.gpu.description || `${env.gpu.vendor} ${env.gpu.architecture} ${env.gpu.device}` : 'n/a'}</td></tr>
</table>`

  if (rendererResults?.length) {
    html += `<h2>Renderer scenarios</h2>
<table>
  <tr>
    <th>Scenario</th><th>Frames</th><th>Wall mean (ms)</th><th>~fps</th><th>CPU mean</th><th>Submit mean</th><th>Frame mean</th><th>p95</th><th>Stddev</th>
  </tr>`
    for (const r of rendererResults) {
      const s = r.stats
      const cpuM = r.cpu ? fmt(r.cpu.mean) : '—'
      const subM = r.submit ? fmt(r.submit.mean) : '—'
      const frmM = r.frame ? fmt(r.frame.mean) : '—'
      const fps = s.mean > 0 ? (1000 / s.mean).toFixed(1) : '—'
      html += `<tr>
        <td>${r.name}</td><td>${r.frames}</td>
        <td>${fmt(s.mean)}</td><td>${fps}</td>
        <td>${cpuM}</td><td>${subM}</td><td>${frmM}</td>
        <td>${fmt(s.p95)}</td><td>${fmt(s.stddev)}</td>
      </tr>`
    }
    html += `</table>`
  }

  if (computeResults?.length) {
    html += `<h2>Compute scenarios</h2>
<table>
  <tr>
    <th>Function</th><th>Size</th><th>Iter</th>
    <th>Mean (ms)</th><th>p95 (ms)</th><th>Stddev</th>
  </tr>`
    for (const r of computeResults) {
      const s = r.stats
      html += `<tr>
        <td>${r.name}</td><td>${r.dataSize}</td><td>${r.iter}</td>
        <td>${fmt(s.mean)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.stddev)}</td>
      </tr>`
    }
    html += `</table>`
  }

  if (sweepResults?.tile?.rows.length) {
    const t = sweepResults.tile
    html += `<h2>Tile-count sweep</h2>
<p style="font-size:12px;color:#8b949e;margin:4px 0 8px">
  Linear fit: <strong>${fmt(t.slope)}</strong> ms/tile (slope) +
  <strong>${fmt(t.intercept)}</strong> ms (intercept)
</p>
<table>
  <tr><th>Tiles</th><th>Mosaic</th><th>Frames</th><th>Mean (ms)</th><th>Median</th><th>p95</th><th>Min</th><th>Max</th><th>Stddev</th></tr>`
    for (const r of t.rows) {
      const s = r.stats
      html += `<tr>
        <td>${r.tiles}</td><td><code>${r.mosaic}</code></td><td>${r.frames}</td>
        <td>${fmt(s.mean)}</td><td>${fmt(s.median)}</td><td>${fmt(s.p95)}</td>
        <td>${fmt(s.min)}</td><td>${fmt(s.max)}</td><td>${fmt(s.stddev)}</td>
      </tr>`
    }
    html += `</table>`
  }

  if (sweepResults?.mesh?.length) {
    html += `<h2>Mesh-size sweep</h2>
<table>
  <tr>
    <th>Verts/mesh</th><th>Meshes</th><th>Total verts</th><th>Frames</th>
    <th>Mean (ms)</th><th>p95</th><th>Uniform B/frame</th>
  </tr>`
    for (const r of sweepResults.mesh) {
      if (r.skipped) {
        html += `<tr>
          <td>${r.size}</td><td>${r.count}</td><td>${r.totalVerts.toLocaleString()}</td>
          <td colspan="4" class="neutral">skipped (${r.skipped})</td>
        </tr>`
        continue
      }
      const s = r.stats
      html += `<tr>
        <td>${r.size}</td><td>${r.count}</td><td>${r.totalVerts.toLocaleString()}</td>
        <td>${r.frames}</td>
        <td>${fmt(s.mean)}</td><td>${fmt(s.p95)}</td>
        <td>${r.uniformBytesPerFrame.toLocaleString()}</td>
      </tr>`
    }
    html += `</table>`
  }

  if (tractResults?.length) {
    html += `<h2>Tract regeneration</h2>
<table>
  <tr>
    <th>Streamlines</th><th>Pts/streamline</th><th>Iter</th>
    <th>Mean (ms)</th><th>p95 (ms)</th><th>ms / 1k streamlines</th>
  </tr>`
    for (const r of tractResults) {
      const s = r.stats
      html += `<tr>
        <td>${r.nStreamlines.toLocaleString()}</td><td>${r.pointsPerStreamline}</td><td>${r.iter}</td>
        <td>${fmt(s.mean)}</td><td>${fmt(s.p95)}</td>
        <td>${fmt(r.msPer1kStreamlines)}</td>
      </tr>`
    }
    html += `</table>`
  }

  if (bundleSizes?.entries?.length) {
    html += `<h2>Bundle sizes</h2>
<p style="font-size:12px;color:#8b949e;margin:4px 0 8px">
  Snapshot from <code>scripts/report-entry-sizes.js</code> at <code>${bundleSizes.timestamp || 'unknown'}</code>.
</p>
<table>
  <tr><th>Entry</th><th>Min (KB)</th><th>Gzip (KB)</th></tr>`
    for (const e of bundleSizes.entries) {
      const min = e.minKB != null ? e.minKB.toFixed(2) : '—'
      const gz = e.gzipKB != null ? e.gzipKB.toFixed(2) : '—'
      html += `<tr><td><code>${e.name}</code></td><td>${min}</td><td>${gz}</td></tr>`
    }
    html += `</table>`
  }

  resultsDiv.innerHTML = html
}

// ---------------------------------------------------------------------------
// Export: JSON
// ---------------------------------------------------------------------------

function buildJson(
  env,
  computeResults,
  rendererResults,
  sweepResults,
  tractResults,
  bundleSizes,
) {
  const json = {
    schema: 'niivue-benchmark-v1',
    timestamp: env.timestamp,
    env,
    renderer: rendererResults.map((r) => ({
      name: r.name,
      frames: r.frames,
      stats: r.stats,
      cpu: r.cpu ?? null,
      submit: r.submit ?? null,
      frame: r.frame ?? null,
    })),
    compute: computeResults.map((r) => ({
      name: r.name,
      category: r.category,
      dataSize: r.dataSize,
      iterations: r.iter,
      stats: r.stats,
    })),
  }
  if (sweepResults) {
    json.sweeps = {
      tile: sweepResults.tile && {
        rows: sweepResults.tile.rows.map((r) => ({
          tiles: r.tiles,
          mosaic: r.mosaic,
          frames: r.frames,
          stats: r.stats,
        })),
        slope: sweepResults.tile.slope,
        intercept: sweepResults.tile.intercept,
      },
      mesh: sweepResults.mesh?.map((r) => ({
        size: r.size,
        count: r.count,
        totalVerts: r.totalVerts,
        frames: r.frames,
        stats: r.stats,
        uniformBytesPerFrame: r.uniformBytesPerFrame,
        skipped: r.skipped,
      })),
    }
  }
  if (tractResults?.length) {
    json.tract = tractResults.map((r) => ({
      label: r.label,
      nStreamlines: r.nStreamlines,
      pointsPerStreamline: r.pointsPerStreamline,
      iter: r.iter,
      stats: r.stats,
      msPer1kStreamlines: r.msPer1kStreamlines,
    }))
  }
  if (bundleSizes) {
    json.bundleSizes = bundleSizes
  }
  return json
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// Export: Markdown
// ---------------------------------------------------------------------------

function buildMarkdown(
  env,
  computeResults,
  rendererResults,
  sweepResults,
  tractResults,
  bundleSizes,
) {
  const lines = []
  lines.push(`## Run ${env.timestamp}`)
  lines.push('')
  lines.push(`**Environment**`)
  lines.push(`- Platform: ${env.platform}`)
  lines.push(
    `- GPU: ${env.gpu ? env.gpu.description || `${env.gpu.vendor} ${env.gpu.architecture} ${env.gpu.device}` : 'n/a'}`,
  )
  lines.push(`- User Agent: ${env.userAgent}`)
  lines.push('')

  if (rendererResults?.length) {
    lines.push('### Renderer scenarios')
    lines.push('')
    lines.push(
      '| Scenario | Frames | Wall mean (ms) | ~fps | CPU mean | Submit mean | Frame mean | p95 | Stddev |',
    )
    lines.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of rendererResults) {
      const s = r.stats
      const cpuM = r.cpu ? fmt(r.cpu.mean) : '—'
      const subM = r.submit ? fmt(r.submit.mean) : '—'
      const frmM = r.frame ? fmt(r.frame.mean) : '—'
      const fps = s.mean > 0 ? (1000 / s.mean).toFixed(1) : '—'
      lines.push(
        `| ${r.name} | ${r.frames} | ${fmt(s.mean)} | ${fps} | ${cpuM} | ${subM} | ${frmM} | ${fmt(s.p95)} | ${fmt(s.stddev)} |`,
      )
    }
    lines.push('')
  }

  if (computeResults?.length) {
    lines.push('### Compute scenarios')
    lines.push('')
    lines.push('| Function | Size | Iter | Mean (ms) | p95 (ms) | Stddev |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of computeResults) {
      const s = r.stats
      lines.push(
        `| ${r.name} | ${r.dataSize} | ${r.iter} | ${fmt(s.mean)} | ${fmt(s.p95)} | ${fmt(s.stddev)} |`,
      )
    }
    lines.push('')
  }

  if (sweepResults?.tile?.rows.length) {
    const t = sweepResults.tile
    lines.push('### Tile-count sweep')
    lines.push('')
    lines.push(
      `Linear fit: **${fmt(t.slope)} ms/tile** (slope) + **${fmt(t.intercept)} ms** (intercept)`,
    )
    lines.push('')
    lines.push(
      '| Tiles | Mosaic | Frames | Mean (ms) | Median | p95 | Min | Max | Stddev |',
    )
    lines.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of t.rows) {
      const s = r.stats
      lines.push(
        `| ${r.tiles} | \`${r.mosaic}\` | ${r.frames} | ${fmt(s.mean)} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.stddev)} |`,
      )
    }
    lines.push('')
  }

  if (sweepResults?.mesh?.length) {
    lines.push('### Mesh-size sweep')
    lines.push('')
    lines.push(
      '| Verts/mesh | Meshes | Total verts | Frames | Mean (ms) | p95 | Uniform B/frame |',
    )
    lines.push('|---|---|---|---|---|---|---|')
    for (const r of sweepResults.mesh) {
      if (r.skipped) {
        lines.push(
          `| ${r.size} | ${r.count} | ${r.totalVerts.toLocaleString()} | — | — | — | _skipped (${r.skipped})_ |`,
        )
        continue
      }
      const s = r.stats
      lines.push(
        `| ${r.size} | ${r.count} | ${r.totalVerts.toLocaleString()} | ${r.frames} | ${fmt(s.mean)} | ${fmt(s.p95)} | ${r.uniformBytesPerFrame.toLocaleString()} |`,
      )
    }
    lines.push('')
  }

  if (tractResults?.length) {
    lines.push('### Tract regeneration')
    lines.push('')
    lines.push(
      '| Streamlines | Pts/streamline | Iter | Mean (ms) | p95 (ms) | ms / 1k streamlines |',
    )
    lines.push('|---|---|---|---|---|---|')
    for (const r of tractResults) {
      const s = r.stats
      lines.push(
        `| ${r.nStreamlines.toLocaleString()} | ${r.pointsPerStreamline} | ${r.iter} | ${fmt(s.mean)} | ${fmt(s.p95)} | ${fmt(r.msPer1kStreamlines)} |`,
      )
    }
    lines.push('')
  }

  if (bundleSizes?.entries?.length) {
    lines.push('### Bundle sizes')
    lines.push('')
    lines.push(
      `Snapshot from \`scripts/report-entry-sizes.js\` at \`${bundleSizes.timestamp || 'unknown'}\`.`,
    )
    lines.push('')
    lines.push('| Entry | Min (KB) | Gzip (KB) |')
    lines.push('|---|---|---|')
    for (const e of bundleSizes.entries) {
      const min = e.minKB != null ? e.minKB.toFixed(2) : '—'
      const gz = e.gzipKB != null ? e.gzipKB.toFixed(2) : '—'
      lines.push(`| \`${e.name}\` | ${min} | ${gz} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// NiiVue setup and main run
// ---------------------------------------------------------------------------

setStatus('Initializing NiiVue...')
const nv = new NiiVue({
  backgroundColor: [0.05, 0.05, 0.05, 1],
  isOrientationTextVisible: false,
  isOrientCubeVisible: false,
  isColorbarVisible: false,
})
await nv.attachToCanvas(canvasA)
if (!isPerfBuild()) {
  setStatus(
    'Ready, but this is a non-perf build — CPU/submit splits and phase stats will be empty. Run `bun run dev:perf` for instrumented numbers.',
  )
} else {
  setStatus('Ready (perf build). Click Run to start benchmark.')
}

let _lastRun = null

runBtn.onclick = async () => {
  _aborted = false
  runBtn.disabled = true
  abortBtn.disabled = false
  exportJsonBtn.disabled = true
  exportMdBtn.disabled = true
  copyMdBtn.disabled = true
  runBtn.textContent = 'Running...'
  resultsDiv.innerHTML = ''
  mdOut.classList.add('hidden')

  const frames =
    parseInt(document.getElementById('frameCount').value, 10) || 300
  const computeIter =
    parseInt(document.getElementById('computeIter').value, 10) || 100
  const runRenderer = document.getElementById('runRenderer').checked
  const runComp = document.getElementById('runCompute').checked
  const runSwp = document.getElementById('runSweeps').checked
  const runTractEl = document.getElementById('runTract')
  const runTrct = runTractEl ? runTractEl.checked : false

  try {
    const env = await captureEnv()
    const urlParams = new URLSearchParams(window.location.search)
    const usePaced = urlParams.get('paced') === '1'
    setBenchPaced(usePaced)
    if (usePaced) setStatus('paced=1 (await GPU per frame)')

    let computeResults = []
    let rendererResults = []
    let sweepResults = null
    let tractResults = []

    if (runRenderer) {
      rendererResults = await rendererScenarios(nv, frames)
    }
    if (runComp) {
      computeResults = await runCompute(computeIter)
    }
    if (runSwp) {
      sweepResults = await runSweeps(nv, frames)
    }
    if (runTrct) {
      tractResults = await tractRegen(5)
    }
    const bundleSizes = await fetchBundleSizes()

    _lastRun = {
      env,
      computeResults,
      rendererResults,
      sweepResults,
      tractResults,
      bundleSizes,
    }
    renderResultsTable(
      env,
      computeResults,
      rendererResults,
      sweepResults,
      tractResults,
      bundleSizes,
    )
    setStatus('Done.')
    exportJsonBtn.disabled = false
    exportMdBtn.disabled = false
    copyMdBtn.disabled = false
    // Headless/autorun consumers (Playwright in CI) read this directly.
    window.__bench = buildJson(
      env,
      computeResults,
      rendererResults,
      sweepResults,
      tractResults,
      bundleSizes,
    )
  } catch (err) {
    if (err.message === ABORT_ERROR) {
      setStatus('Aborted.')
      window.__benchError = 'aborted'
    } else {
      console.error(err)
      setStatus(`Error: ${err.message || err}`)
      resultsDiv.innerHTML = `<pre style="color:#f85149">${err.stack || err}</pre>`
      window.__benchError = err.message || String(err)
    }
  } finally {
    abortBtn.disabled = true
    runBtn.disabled = false
    runBtn.textContent = 'Run'
    window.__benchDone = true
  }
}

exportJsonBtn.onclick = () => {
  if (!_lastRun) return
  const json = buildJson(
    _lastRun.env,
    _lastRun.computeResults,
    _lastRun.rendererResults,
    _lastRun.sweepResults,
    _lastRun.tractResults,
    _lastRun.bundleSizes,
  )
  const stamp = json.timestamp.replace(/[:.]/g, '-')
  downloadBlob(
    JSON.stringify(json, null, 2),
    `benchmark-${stamp}.json`,
    'application/json',
  )
}

exportMdBtn.onclick = () => {
  if (!_lastRun) return
  const md = buildMarkdown(
    _lastRun.env,
    _lastRun.computeResults,
    _lastRun.rendererResults,
    _lastRun.sweepResults,
    _lastRun.tractResults,
    _lastRun.bundleSizes,
  )
  const stamp = _lastRun.env.timestamp.replace(/[:.]/g, '-')
  downloadBlob(md, `benchmark-${stamp}.md`, 'text/markdown')
  mdOut.textContent = md
  mdOut.classList.remove('hidden')
}

copyMdBtn.onclick = async () => {
  if (!_lastRun) return
  const md = buildMarkdown(
    _lastRun.env,
    _lastRun.computeResults,
    _lastRun.rendererResults,
    _lastRun.sweepResults,
    _lastRun.tractResults,
    _lastRun.bundleSizes,
  )
  try {
    await navigator.clipboard.writeText(md)
    setStatus('Markdown copied to clipboard.')
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// Autorun mode for headless/CI consumers.
//
// Append `?autorun=1` to the URL to run without clicking. Optional overrides:
//   frames=<int>      computeIter=<int>
//   renderer=0|1      compute=0|1      sweeps=0|1      tract=0|1
//
// When the run finishes, results are exposed as:
//   window.__bench       — full JSON (schema niivue-benchmark-v1)
//   window.__benchDone   — true (always, even on error/abort)
//   window.__benchError  — string (set only on error/abort)
//
// Playwright contract: navigate, then `waitForFunction(() => window.__benchDone)`.
// ---------------------------------------------------------------------------
{
  const params = new URLSearchParams(window.location.search)
  if (params.get('autorun') === '1') {
    const setIfPresent = (id, key) => {
      const v = params.get(key)
      if (v == null) return
      const el = document.getElementById(id)
      if (!el) return
      if (el.type === 'checkbox') el.checked = v === '1'
      else el.value = v
    }
    setIfPresent('frameCount', 'frames')
    setIfPresent('computeIter', 'computeIter')
    setIfPresent('runRenderer', 'renderer')
    setIfPresent('runCompute', 'compute')
    setIfPresent('runSweeps', 'sweeps')
    setIfPresent('runTract', 'tract')
    // Defer one tick so the DOM/UI shows the chosen values before the run.
    setTimeout(() => runBtn.click(), 0)
  }
}
