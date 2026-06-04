// Overlay-on-a-large-volume demo.
//
// A large OME-Zarr volume is loaded as a chunked *streaming* background, and a
// co-registered scalar overlay is layered on top via `nv.loadVolumes([bg, ov])`.
// niivue reslices the overlay onto each background brick as it streams in (the
// chunked-overlay path: `overlay2TextureChunked`), so the overlay rides the same
// visibility-driven working set as the background — only the visible bricks
// carry overlay texels.
//
// The overlay here is derived from the volume itself: a coarse pyramid level is
// fetched whole and z-scored into a statistical map (hot where denser than
// average), co-registered because it is the same pyramid. The same coarse fetch
// also drives the background's "punchy" display window (the omezarr-style upper-
// half-of-robust-range), so the underlying anatomy reads bright under the overlay.

import NiiVue, { type NVImage, type VolumeChunkSource } from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import {
  buildLogicalVolume,
  niftiDatatype,
  type Shape3,
} from './logical-volume'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
const baseUrl = window.location.origin

// Experiment knobs (URL params):
//   ?budgetGB=N  — override the residency budget (default 2 GB). Raise it to fit
//                  a finer level's whole footprint resident for the 3D render.
//   ?level=N     — pin the base stream level (e.g. 0 = full-res L0), bypassing
//                  the budget-based pick. Combine with a large budget for L0.
const urlParams = new URLSearchParams(window.location.search)
const budgetGB = Number(urlParams.get('budgetGB'))
const forcedLevelParam = urlParams.get('level')
const forcedLevel =
  forcedLevelParam != null && forcedLevelParam !== ''
    ? Number(forcedLevelParam)
    : null

const CHUNK_EDGE = 256
const RESIDENCY_BYTES =
  Number.isFinite(budgetGB) && budgetGB > 0
    ? Math.round(budgetGB * 1_000_000_000)
    : 2_000_000_000
const DEFAULT_ID = 'pawpawsaurus.ome.zarr'
// Resident GPU bytes per level-voxel: background RGBA8 + gradient (8) plus the
// overlay chunk (~4), times a halo-overlap factor (~1.4). The 3D render tile
// needs *every* chunk resident at once, so we stream the finest level whose whole
// footprint fits the budget — otherwise the LRU thrashes (evict + re-stream +
// re-reslice the overlay each frame), which is what made it crawl.
const RESIDENT_BYTES_PER_VOXEL = 16
// Longest-edge cap for the level the statistical overlay is computed from: small
// enough to fetch whole in one request, detailed enough to read as a stat map.
const OVERLAY_MAX = 384

type Bbox6 = [number, number, number, number, number, number]

interface VolumeLevel {
  level: number
  shape: Shape3
  spacing: Shape3
  bytes: number | null
}
interface VolumeApiEntry {
  id: string
  format: string
  shape: Shape3
  spacing: Shape3
  dtype: string
  levels?: VolumeLevel[]
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  volume: el<HTMLSelectElement>('volume'),
  layout: el<HTMLSelectElement>('layout'),
  cmap: el<HTMLSelectElement>('cmap'),
  opacity: el<HTMLInputElement>('opacity'),
  zoom: el<HTMLInputElement>('zoom'),
  overlayOn: el<HTMLInputElement>('overlayOn'),
  streamHiRes: el<HTMLInputElement>('streamHiRes'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let current: VolumeApiEntry | null = null
let fetched = new Set<number>()
let overlayFetched = new Set<number>()
let bgWin: { min: number; max: number } = { min: 0, max: 1 }
// Levels chosen for the current load (for the HUD); updated in loadAll.
let loadedBgLevel = 0
let loadedOvLevel = 0

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function levelsSorted(v: VolumeApiEntry): VolumeLevel[] {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  return [...levels].sort((a, b) => a.level - b.level) // finest first
}

// Finest level whose whole footprint fits `budget` resident GPU bytes. The 3D
// render tile needs every chunk resident at once, so streaming a finer level
// than this just thrashes the LRU.
function levelFitting(v: VolumeApiEntry, budget: number): VolumeLevel {
  const sorted = levelsSorted(v)
  for (const l of sorted) {
    const voxels = l.shape[0] * l.shape[1] * l.shape[2]
    if (voxels * RESIDENT_BYTES_PER_VOXEL <= budget) return l
  }
  return sorted[sorted.length - 1] // coarsest as a last resort
}

function streamLevel(v: VolumeApiEntry): VolumeLevel {
  return levelFitting(v, RESIDENCY_BYTES)
}

// The level one step coarser than `lvl` (clamped to the coarsest available).
function coarserLevel(v: VolumeApiEntry, lvl: VolumeLevel): VolumeLevel {
  const sorted = levelsSorted(v)
  const idx = sorted.findIndex((l) => l.level === lvl.level)
  return sorted[Math.min(idx + 1, sorted.length - 1)]
}

function bytesPerVoxelForDtype(dtype: string): number {
  switch (dtype) {
    case 'uint8':
    case 'int8':
      return 1
    case 'float32':
      return 4
    default:
      return 2 // uint16 / int16
  }
}

function decodeScalarChunk(
  buf: Uint8Array,
  dtype: string,
  n: number,
): Float32Array {
  const out = new Float32Array(n)
  const ab = buf.buffer as ArrayBuffer
  const off = buf.byteOffset
  switch (dtype) {
    case 'uint8': {
      for (let i = 0; i < n; i++) out[i] = buf[i]
      break
    }
    case 'int8': {
      const a = new Int8Array(ab, off, n)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
    case 'int16': {
      const a = new Int16Array(ab, off, n)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
    case 'float32': {
      out.set(new Float32Array(ab, off, n))
      break
    }
    default: {
      const a = new Uint16Array(ab, off, n)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
  }
  return out
}

function fetchRawChunk(
  id: string,
  level: number,
  desc: { texOrigin: readonly number[]; texDims: readonly number[] },
  bpv: number,
): Promise<Uint8Array> {
  const bbox: Bbox6 = [
    desc.texOrigin[0],
    desc.texOrigin[1],
    desc.texOrigin[2],
    desc.texOrigin[0] + desc.texDims[0],
    desc.texOrigin[1] + desc.texDims[1],
    desc.texOrigin[2] + desc.texDims[2],
  ]
  const url = `${baseUrl}/volumes/${encodeURIComponent(id)}/raw.bin?level=${level}&bbox=${bbox.join(',')}`
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const expected = desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bpv
    if (buf.byteLength !== expected) {
      throw new Error(
        `chunk ${bbox} got ${buf.byteLength}B, expected ${expected}`,
      )
    }
    return buf
  })
}

// The same "punchy" display window the omezarr demo uses. niivue auto-calibrates
// a wide 2-98% robust range whose low end renders as translucent haze; omezarr
// re-windows onto the *upper half* of that range and stretches the max to the
// global peak so dense structure reads bright. The streamed background here has
// no img for niivue to auto-calibrate, so we compute the robust 2-98% range from
// the coarse scalars (cheap histogram over the non-zero object voxels) and apply
// the same transform.
function punchyWindow(scalars: Float32Array): { min: number; max: number } {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  let count = 0
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    if (s > 0) {
      if (s < lo) lo = s
      if (s > hi) hi = s
      count++
    }
  }
  if (count === 0 || hi <= lo) return { min: 0, max: 1 }
  const BINS = 256
  const hist = new Uint32Array(BINS)
  const scale = (BINS - 1) / (hi - lo)
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    if (s > 0) hist[Math.floor((s - lo) * scale)]++
  }
  const loCut = count * 0.02
  const hiCut = count * 0.98
  let cum = 0
  let pLo = lo
  let pHi = hi
  for (let b = 0; b < BINS; b++) {
    cum += hist[b]
    if (cum >= loCut) {
      pLo = lo + b / scale
      break
    }
  }
  cum = 0
  for (let b = 0; b < BINS; b++) {
    cum += hist[b]
    if (cum >= hiCut) {
      pHi = lo + b / scale
      break
    }
  }
  // omezarr's punchyWindow: min = midpoint of the robust range, max = global peak.
  const min = pLo + 0.5 * (pHi - pLo)
  const max = hi > pHi ? hi : pHi
  return {
    min: Math.round(min),
    max: max > min ? Math.round(max) : Math.round(min) + 1,
  }
}

function createBackground(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  win: { min: number; max: number },
): NVImage {
  const dt = niftiDatatype(v.dtype)
  const cache = new Map<number, Promise<Uint8Array>>()
  const chunkSource: VolumeChunkSource = (request) => {
    const hit = cache.get(request.chunkIndex)
    if (hit) return hit
    fetched.add(request.chunkIndex)
    const next = fetchRawChunk(
      v.id,
      lvl.level,
      request.desc,
      request.bytesPerVoxel,
    ).then((buf) => {
      renderHud()
      return buf
    })
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
  return buildLogicalVolume({
    id: `${v.id} L${lvl.level} background`,
    url: `ov-bg://${encodeURIComponent(v.id)}/L${lvl.level}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: dt.code,
    numBitsPerVoxel: dt.bits,
    calMin: win.min,
    calMax: win.max,
    colormap: 'gray',
    chunkSource,
  })
}

// Pick a coarse level for the overlay: the finest whose longest edge fits
// OVERLAY_MAX, so the whole level is a quick single fetch. It covers the same mm
// box as the streamed background (same pyramid), so the two register.
function overlayLevel(v: VolumeApiEntry): VolumeLevel {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  for (const l of [...levels].sort((a, b) => a.level - b.level)) {
    if (Math.max(...l.shape) <= OVERLAY_MAX) return l
  }
  return levels[levels.length - 1]
}

// Fetch a whole pyramid level as scalar intensities (one number per voxel).
async function fetchLevelScalars(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
): Promise<Float32Array> {
  const bbox = [0, 0, 0, lvl.shape[0], lvl.shape[1], lvl.shape[2]]
  const url = `${baseUrl}/volumes/${encodeURIComponent(v.id)}/raw.bin?level=${lvl.level}&bbox=${bbox.join(',')}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  const buf = await res.arrayBuffer()
  const n = lvl.shape[0] * lvl.shape[1] * lvl.shape[2]
  const out = new Float32Array(n)
  switch (v.dtype) {
    case 'uint8':
    case 'int8': {
      const a = new Uint8Array(buf)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
    case 'int16': {
      const a = new Int16Array(buf)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
    case 'float32': {
      out.set(new Float32Array(buf).subarray(0, n))
      break
    }
    default: {
      const a = new Uint16Array(buf)
      for (let i = 0; i < n; i++) out[i] = a[i]
      break
    }
  }
  return out
}

// Mean/std of the non-zero (object) voxels — the z-score normalisation stats.
function computeStats(scalars: Float32Array): { mean: number; std: number } {
  let sum = 0
  let count = 0
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    if (s > 0) {
      sum += s
      count++
    }
  }
  const mean = count ? sum / count : 0
  let varSum = 0
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    if (s > 0) {
      const d = s - mean
      varSum += d * d
    }
  }
  const std = count ? Math.sqrt(varSum / count) || 1 : 1
  return { mean, std }
}

// Turn the volume's own intensities into a statistical (z-score) overlay: per
// voxel z = (intensity - mean) / std over the non-zero (object) voxels. Shown in
// a hot colormap above z = 1, it reads like a stat map on the anatomy — the same
// image, overlaid on itself, highlighting the denser-than-average structure.
// In-memory variant: a coarse whole level, resliced onto the base grid.
function createStatOverlay(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  scalars: Float32Array,
): NVImage {
  const { mean, std } = computeStats(scalars)
  const img = new Float32Array(scalars.length)
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    img[i] = s > 0 ? (s - mean) / std : 0
  }
  return buildLogicalVolume({
    id: `${v.id} z-overlay`,
    url: `ov-stat://${encodeURIComponent(v.id)}/L${lvl.level}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: 16, // DT_FLOAT32
    numBitsPerVoxel: 32,
    calMin: 1.0,
    calMax: 4.0,
    colormap: els.cmap.value || 'warm',
    opacity: Number(els.opacity.value),
    isTransparentBelowCalMin: true,
    img,
  })
}

// Streamed, higher-resolution variant of the z-score overlay: its own ChunkPlan
// + residency, fetched brick-by-brick at a *finer* level than the base and
// z-scored client-side per chunk (using the coarse-level mean/std). chunkOverlayOf
// makes niivue composite it as translucent cubes over the base, sampled through
// its own (finer) grid instead of reslicing onto the coarse base grid.
function createStreamedStatOverlay(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  stats: { mean: number; std: number },
  baseUrlKey: string,
): NVImage {
  const srcBpv = bytesPerVoxelForDtype(v.dtype)
  const cache = new Map<number, Promise<Uint8Array>>()
  const chunkSource: VolumeChunkSource = (request) => {
    const hit = cache.get(request.chunkIndex)
    if (hit) return hit
    overlayFetched.add(request.chunkIndex)
    const td = request.desc.texDims
    const n = td[0] * td[1] * td[2]
    const next = fetchRawChunk(v.id, lvl.level, request.desc, srcBpv).then(
      (raw) => {
        const s = decodeScalarChunk(raw, v.dtype, n)
        const z = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const val = s[i]
          z[i] = val > 0 ? (val - stats.mean) / stats.std : 0
        }
        renderHud()
        return new Uint8Array(z.buffer)
      },
    )
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
  return buildLogicalVolume({
    id: `${v.id} z-overlay (streamed L${lvl.level})`,
    url: `ov-stat-stream://${encodeURIComponent(v.id)}/L${lvl.level}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: 16, // DT_FLOAT32 (z-score baked client-side per chunk)
    numBitsPerVoxel: 32,
    calMin: 1.0,
    calMax: 4.0,
    colormap: els.cmap.value || 'warm',
    opacity: Number(els.opacity.value),
    isTransparentBelowCalMin: true,
    chunkSource,
    chunkOverlayOf: baseUrlKey,
    chunkOverlayOpacity: Number(els.opacity.value),
  })
}

function renderHud(): void {
  if (!current) return
  const streamed = els.streamHiRes.checked && els.overlayOn.checked
  const ovLine = !els.overlayOn.checked
    ? 'z-score overlay: off'
    : streamed
      ? `z-score overlay: streamed L${loadedOvLevel} (hi-res), ` +
        `${els.cmap.value}, opacity ${els.opacity.value}\n` +
        `overlay bricks fetched: ${overlayFetched.size}`
      : `z-score overlay: resliced (coarse), ${els.cmap.value}, ` +
        `opacity ${els.opacity.value}`
  const s = nv?.chunkStreamStats?.() ?? null
  const gpuLine = s
    ? `\nGPU bricks resident: ${s.resident}/${s.total}` +
      (s.pending || s.inFlight
        ? ` (streaming: ${s.inFlight} in-flight, ${s.pending} queued)`
        : ' (settled)')
    : ''
  els.hud.textContent =
    `background: ${current.id}\n` +
    `base level ${loadedBgLevel} · ${current.dtype}\n` +
    `window: ${Math.round(bgWin.min)}–${Math.round(bgWin.max)}\n` +
    `base bricks fetched: ${fetched.size}\n` +
    ovLine +
    gpuLine
}

// While bricks are still streaming in, refresh the HUD each frame so the
// resident/queued counts update live (uploads happen async between frames).
let streamPollHandle = 0
function pollStreamingHud(): void {
  if (streamPollHandle) cancelAnimationFrame(streamPollHandle)
  const tick = () => {
    renderHud()
    const s = nv?.chunkStreamStats?.() ?? null
    if (s && (s.pending > 0 || s.inFlight > 0)) {
      streamPollHandle = requestAnimationFrame(tick)
    } else {
      streamPollHandle = 0
    }
  }
  streamPollHandle = requestAnimationFrame(tick)
}

async function loadAll(v: VolumeApiEntry): Promise<void> {
  if (!nv) return
  current = v
  fetched = new Set()
  overlayFetched = new Set()
  const streamed = els.streamHiRes.checked && els.overlayOn.checked
  // Hi-res streamed overlay: the overlay takes the finer level (fits half the
  // budget) and the base drops one level coarser, so the overlay visibly
  // out-resolves the base. Otherwise the base takes the finest fitting level
  // and the overlay is the coarse resliced map.
  const ovStreamLvl = streamed ? levelFitting(v, RESIDENCY_BYTES * 0.5) : null
  // ?level=N pins the base to that pyramid level (e.g. 0 = full-res L0),
  // overriding the budget-based pick. Use with a large ?budgetGB.
  const pinned =
    forcedLevel != null
      ? levelsSorted(v).find((l) => l.level === forcedLevel)
      : undefined
  const bgLvl =
    pinned ??
    (ovStreamLvl != null ? coarserLevel(v, ovStreamLvl) : streamLevel(v))
  const coarseLvl = overlayLevel(v) // window + z-score stats source
  loadedBgLevel = bgLvl.level
  loadedOvLevel = (ovStreamLvl ?? coarseLvl).level
  els.mag.textContent = streamed
    ? `base L${bgLvl.level} · overlay L${ovStreamLvl?.level}…`
    : `streaming L${bgLvl.level} · windowing from L${coarseLvl.level}…`
  // One coarse-level fetch drives the background's display window and the
  // z-score normalisation stats (same volume), so the anatomy is visible and
  // the overlay registers.
  let scalars: Float32Array
  try {
    scalars = await fetchLevelScalars(v, coarseLvl)
  } catch (err) {
    showFallback(
      `level fetch failed: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  bgWin = punchyWindow(scalars)
  const bgUrlKey = `ov-bg://${encodeURIComponent(v.id)}/L${bgLvl.level}`
  const list = [createBackground(v, bgLvl, bgWin)]
  if (els.overlayOn.checked) {
    list.push(
      ovStreamLvl != null
        ? createStreamedStatOverlay(
            v,
            ovStreamLvl,
            computeStats(scalars),
            bgUrlKey,
          )
        : createStatOverlay(v, coarseLvl, scalars),
    )
  }
  try {
    await nv.loadVolumes(list)
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  // The streamed overlay only composites in the 3D render; force that layout so
  // the hi-res layer is visible.
  if (streamed) els.layout.value = '4'
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  renderHud()
  pollStreamingHud()
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: VolumeApiEntry[] }
  volumes = (json.volumes ?? []).filter(
    (v) => v.format === 'ome-zarr' && Math.min(...v.shape) > 1,
  )
  if (volumes.length === 0) {
    showFallback(
      'No 3D OME-Zarr volumes in /api. Run `nx run iiif-volumetric-server:fetch-omezarr` and restart the server.',
    )
    return
  }
  els.volume.replaceChildren()
  for (const v of volumes) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = `${v.id} (${v.shape.join('×')}, ${v.dtype})`
    els.volume.appendChild(opt)
  }
  const initial = volumes.find((v) => v.id === DEFAULT_ID) ?? volumes[0]
  els.volume.value = initial.id

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
    maxTextureDimension3D: CHUNK_EDGE,
    maxChunkResidencyBytes: RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)

  els.volume.addEventListener('change', () => {
    const v = volumes.find((x) => x.id === els.volume.value)
    if (v) void loadAll(v)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  els.overlayOn.addEventListener('change', () => {
    if (current) void loadAll(current)
  })
  els.streamHiRes.addEventListener('change', () => {
    if (current) void loadAll(current)
  })
  // 3D zoom (scene scale). Lets you zoom into the clipped interior (right-drag a
  // 3D-render tile to set the clip plane) without re-streaming.
  els.zoom.addEventListener('input', () => {
    if (!nv) return
    nv.scaleMultiplier = Number(els.zoom.value)
    nv.drawScene()
  })
  els.cmap.addEventListener('change', () => {
    if (nv && nv.volumes[1]) void nv.setVolume(1, { colormap: els.cmap.value })
    renderHud()
  })
  els.opacity.addEventListener('input', () => {
    if (nv && nv.volumes[1]) {
      void nv.setVolume(1, { opacity: Number(els.opacity.value) })
    }
    renderHud()
  })

  await loadAll(initial)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
