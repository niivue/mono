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

const CHUNK_EDGE = 256
const RESIDENCY_BYTES = 2_000_000_000
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
  overlayOn: el<HTMLInputElement>('overlayOn'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let current: VolumeApiEntry | null = null
let fetched = new Set<number>()
let bgWin: { min: number; max: number } = { min: 0, max: 1 }

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function streamLevel(v: VolumeApiEntry): VolumeLevel {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  const sorted = [...levels].sort((a, b) => a.level - b.level) // finest first
  for (const l of sorted) {
    const voxels = l.shape[0] * l.shape[1] * l.shape[2]
    if (voxels * RESIDENT_BYTES_PER_VOXEL <= RESIDENCY_BYTES) return l
  }
  return sorted[sorted.length - 1] // coarsest as a last resort
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

// Turn the volume's own intensities into a statistical (z-score) overlay: per
// voxel z = (intensity - mean) / std over the non-zero (object) voxels. Shown in
// a hot colormap above z = 1, it reads like a stat map on the anatomy — the same
// image, overlaid on itself, highlighting the denser-than-average structure.
function createStatOverlay(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  scalars: Float32Array,
): NVImage {
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

function renderHud(): void {
  if (!current) return
  const lvl = streamLevel(current)
  els.hud.textContent =
    `background: ${current.id}\n` +
    `level ${lvl.level} · ${lvl.shape.join('×')} · ${current.dtype}\n` +
    `window: ${Math.round(bgWin.min)}–${Math.round(bgWin.max)}\n` +
    `bricks fetched: ${fetched.size}\n` +
    `z-score overlay: ${els.overlayOn.checked ? `${els.cmap.value}, opacity ${els.opacity.value}` : 'off'}`
}

async function loadAll(v: VolumeApiEntry): Promise<void> {
  if (!nv) return
  current = v
  fetched = new Set()
  const lvl = streamLevel(v)
  const ovLvl = overlayLevel(v)
  els.mag.textContent = `streaming L${lvl.level} · windowing from L${ovLvl.level}…`
  // One coarse-level fetch drives both the background's display window and the
  // z-score overlay (same volume), so the anatomy is visible and registered.
  let scalars: Float32Array
  try {
    scalars = await fetchLevelScalars(v, ovLvl)
  } catch (err) {
    showFallback(
      `level fetch failed: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  bgWin = punchyWindow(scalars)
  const list = [createBackground(v, lvl, bgWin)]
  if (els.overlayOn.checked) {
    list.push(createStatOverlay(v, ovLvl, scalars))
  }
  try {
    await nv.loadVolumes(list)
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  renderHud()
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
