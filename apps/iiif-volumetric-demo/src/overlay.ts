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
//                  the budget-based pick. With no ?budgetGB, the residency budget
//                  is auto-sized to fit that whole level (base + overlay), so the
//                  streamed overlay doesn't starve against the base.
const urlParams = new URLSearchParams(window.location.search)
const budgetGB = Number(urlParams.get('budgetGB'))
const forcedLevelParam = urlParams.get('level')
const forcedLevel =
  forcedLevelParam != null && forcedLevelParam !== ''
    ? Number(forcedLevelParam)
    : null

const CHUNK_EDGE = 256
const hasExplicitBudget = Number.isFinite(budgetGB) && budgetGB > 0
const RESIDENCY_BYTES = hasExplicitBudget
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
  opacityWarm: el<HTMLInputElement>('opacityWarm'),
  opacityCool: el<HTMLInputElement>('opacityCool'),
  zoom: el<HTMLInputElement>('zoom'),
  overlayOn: el<HTMLInputElement>('overlayOn'),
  streamHiRes: el<HTMLInputElement>('streamHiRes'),
  rgbaCombine: el<HTMLInputElement>('rgbaCombine'),
  clipOverlay: el<HTMLInputElement>('clipOverlay'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

// Opacity of the two stacked overlays. The warm overlay carries the densest cores
// (z > 1.5), the cool overlay the surrounding structure (0.3 < z <= 1.5).
const warmOpacity = (): number => Number(els.opacityWarm.value)
const coolOpacity = (): number => Number(els.opacityCool.value)

// The currently-loaded streamed overlay's per-brick cache and how its opacity is
// applied, so an opacity change can re-bake in place (nv.rebakeChunkedOverlays())
// instead of reloading the whole volume. 'scalar': opacity is baked by niivue from
// vol.opacity at orient time. 'rgba': opacity is baked into alpha by the chunkSource
// below, so its cache must be cleared to force a re-bake. null in the resliced mode
// (two real stacked overlays, opacity is live-settable via setVolume).
let streamedOverlayCache: Map<number, Promise<Uint8Array>> | null = null
let streamedOverlayKind: 'scalar' | 'rgba' | null = null

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let current: VolumeApiEntry | null = null
let fetched = new Set<number>()
let overlayFetched = new Set<number>()
let bgWin: { min: number; max: number } = { min: 0, max: 1 }
// Levels chosen for the current load (for the HUD); updated in loadAll.
let loadedBgLevel = 0
let loadedOvLevel = 0
// Residency budget handed to niivue (auto-sized when ?level pins a level); HUD.
let activeBudgetBytes = RESIDENCY_BYTES

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

// The residency budget for niivue's chunk manager. When ?level pins a base level
// and no ?budgetGB is given, size it to hold that whole level resident (base +
// overlay + halo, ~RESIDENT_BYTES_PER_VOXEL each) so the streamed overlay keeps
// pace with the base instead of being evicted out of the 40% it is allotted.
// An explicit ?budgetGB always wins.
function residencyBudgetFor(v: VolumeApiEntry): number {
  if (hasExplicitBudget || forcedLevel == null) return RESIDENCY_BYTES
  const lvl = levelsSorted(v).find((l) => l.level === forcedLevel)
  if (!lvl) return RESIDENCY_BYTES
  const voxels = lvl.shape[0] * lvl.shape[1] * lvl.shape[2]
  return Math.max(RESIDENCY_BYTES, voxels * RESIDENT_BYTES_PER_VOXEL)
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
// In-memory variant: a coarse whole level, resliced onto the base grid. Split
// into TWO stacked overlays so each band gets its own colormap and opacity
// slider: a warm map over the densest cores (z > 1.5) and a cool map over the
// surrounding structure (0.3 < z <= 1.5). niivue blends both resliced overlays
// onto the streamed background (volumes[1] = warm, volumes[2] = cool).
function createStatOverlays(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  scalars: Float32Array,
): NVImage[] {
  const { mean, std } = computeStats(scalars)
  const warm = new Float32Array(scalars.length)
  const cool = new Float32Array(scalars.length)
  for (let i = 0; i < scalars.length; i++) {
    const s = scalars[i]
    if (s <= 0) continue
    const z = (s - mean) / std
    if (z > 1.5) warm[i] = z
    else if (z > 0.3) cool[i] = z
  }
  return [
    buildLogicalVolume({
      id: `${v.id} z-overlay warm`,
      url: `ov-stat-warm://${encodeURIComponent(v.id)}/L${lvl.level}`,
      shape: lvl.shape,
      spacing: lvl.spacing,
      datatypeCode: 16, // DT_FLOAT32
      numBitsPerVoxel: 32,
      calMin: 1.5,
      calMax: 4.0,
      colormap: els.cmap.value || 'warm',
      opacity: warmOpacity(),
      isTransparentBelowCalMin: true,
      img: warm,
    }),
    buildLogicalVolume({
      id: `${v.id} z-overlay cool`,
      url: `ov-stat-cool://${encodeURIComponent(v.id)}/L${lvl.level}`,
      shape: lvl.shape,
      spacing: lvl.spacing,
      datatypeCode: 16, // DT_FLOAT32
      numBitsPerVoxel: 32,
      calMin: 0.3,
      calMax: 1.5,
      colormap: 'cool',
      opacity: coolOpacity(),
      isTransparentBelowCalMin: true,
      img: cool,
    }),
  ]
}

// Streamed z-score overlay. With `baseUrlKey` it is an independent hi-res layer
// (strategy B, chunkOverlayOf, own grid). Without it the overlay is co-registered
// at the base grid (same level) and streams as a base-aligned combined overlay
// (strategy A) — combined per block and sampled by the base block's ray-march.
function createStreamedStatOverlay(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  stats: { mean: number; std: number },
  baseUrlKey?: string,
): NVImage {
  const srcBpv = bytesPerVoxelForDtype(v.dtype)
  const cache = new Map<number, Promise<Uint8Array>>()
  // Re-bake driven by niivue from vol.opacity (the z-score bricks are opacity-free).
  streamedOverlayCache = cache
  streamedOverlayKind = 'scalar'
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
    url: `ov-stat-stream://${encodeURIComponent(v.id)}/L${lvl.level}/${baseUrlKey ? 'hires' : 'combined'}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: 16, // DT_FLOAT32 (z-score baked client-side per chunk)
    numBitsPerVoxel: 32,
    calMin: 1.0,
    calMax: 4.0,
    colormap: els.cmap.value || 'warm',
    // Only one streamed/chunked overlay can render at a time, so the streamed
    // mode is a single layer driven by the warm slider.
    opacity: warmOpacity(),
    isTransparentBelowCalMin: true,
    chunkSource,
    // baseUrlKey set => strategy B (independent hi-res); omitted => strategy A
    // (base-grid combined, no chunkOverlayOf).
    chunkOverlayOf: baseUrlKey,
    chunkOverlayOpacity: warmOpacity(),
  })
}

// Multi-layer combined overlay, client-blended into ONE premultiplied-RGBA
// streamed layer (datatype DT_RGBA32). Demonstrates that niivue's combined-
// overlay path accepts RGBA: two colored layers — warm hotspots (z > 1) and cool
// coldspots (z < -1) — are blended per chunk and streamed as a single overlay,
// combined per block by the base ray-march. (rgb is straight, not premultiplied;
// the shader multiplies by alpha.)
function createRgbaCombinedOverlay(
  v: VolumeApiEntry,
  lvl: VolumeLevel,
  stats: { mean: number; std: number },
): NVImage {
  const srcBpv = bytesPerVoxelForDtype(v.dtype)
  const cache = new Map<number, Promise<Uint8Array>>()
  // The two tones are baked into one streamed RGBA layer, so the two sliders set
  // each tone's alpha directly. Opacity is read live per (re-)bake; an opacity
  // change clears this cache and re-streams the affected frustum bricks.
  streamedOverlayCache = cache
  streamedOverlayKind = 'rgba'
  const chunkSource: VolumeChunkSource = (request) => {
    const hit = cache.get(request.chunkIndex)
    if (hit) return hit
    overlayFetched.add(request.chunkIndex)
    const td = request.desc.texDims
    const n = td[0] * td[1] * td[2]
    const next = fetchRawChunk(v.id, lvl.level, request.desc, srcBpv).then(
      (raw) => {
        const opWarm = warmOpacity()
        const opCool = coolOpacity()
        const s = decodeScalarChunk(raw, v.dtype, n)
        const rgba = new Uint8Array(n * 4)
        for (let i = 0; i < n; i++) {
          const val = s[i]
          if (val <= 0) continue
          const z = (val - stats.mean) / stats.std
          let r = 0
          let g = 0
          let b = 0
          let a = 0
          // Two colored layers over the VISIBLE (dense) structure of bimodal
          // data: the densest cores warm (red -> yellow), the surrounding bone
          // cool (blue -> cyan). Both land on the same visible object, so the
          // combine reads as two tones rather than one. (Below z ~ 0.3 the data
          // is mostly air here, so it stays transparent.)
          if (z > 1.5) {
            // warm cores
            r = 255
            g = Math.round(Math.min((z - 1.5) / 2, 1) * 220)
            a = opWarm
          } else if (z > 0.3) {
            // cool surround
            b = 255
            g = Math.round(Math.min((1.5 - z) / 1.2, 1) * 200)
            a = opCool
          }
          const o = i * 4
          rgba[o] = r
          rgba[o + 1] = g
          rgba[o + 2] = b
          rgba[o + 3] = Math.round(a * 255)
        }
        renderHud()
        return rgba
      },
    )
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
  return buildLogicalVolume({
    id: `${v.id} z-overlay (rgba L${lvl.level})`,
    url: `ov-stat-rgba://${encodeURIComponent(v.id)}/L${lvl.level}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: 2304, // DT_RGBA32 — uploaded straight (no colormap)
    numBitsPerVoxel: 32,
    calMin: 0,
    calMax: 1,
    colormap: 'gray',
    opacity: 1,
    chunkSource,
  })
}

function renderHud(): void {
  if (!current) return
  const streamed = els.streamHiRes.checked && els.overlayOn.checked
  const ovLine = !els.overlayOn.checked
    ? 'z-score overlay: off'
    : streamed
      ? `z-score overlay: streamed combined L${loadedOvLevel}` +
        (els.rgbaCombine.checked
          ? ` (RGBA two-tone), warm ${els.opacityWarm.value}/cool ${els.opacityCool.value}`
          : `, ${els.cmap.value}, opacity ${els.opacityWarm.value}`) +
        `\noverlay bricks fetched: ${overlayFetched.size}`
      : `z-score overlay: resliced (coarse), warm ${els.cmap.value} ` +
        `${els.opacityWarm.value}/cool ${els.opacityCool.value}`
  const s = nv?.chunkStreamStats?.() ?? null
  const gpuLine = s
    ? `\nGPU bricks resident: ${s.resident}/${s.total}` +
      (s.pending || s.inFlight
        ? ` (streaming: ${s.inFlight} in-flight, ${s.pending} queued)`
        : ' (settled)')
    : ''
  els.hud.textContent =
    `background: ${current.id}\n` +
    `base level ${loadedBgLevel} · ${current.dtype} · budget ${(activeBudgetBytes / 1e9).toFixed(1)}GB\n` +
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

// The cool slider drives a real overlay only in the resliced mode (volumes[2])
// and the RGBA two-tone bake. In the plain streamed scalar mode there is a single
// warm layer and nothing for it to control, so disable it to avoid a dead knob.
function syncControls(): void {
  const plainStreamed =
    els.streamHiRes.checked && !els.rgbaCombine.checked && els.overlayOn.checked
  els.opacityCool.disabled = plainStreamed
}

async function loadAll(v: VolumeApiEntry): Promise<void> {
  if (!nv) return
  current = v
  fetched = new Set()
  overlayFetched = new Set()
  // Reset streamed-overlay re-bake state; the create* helpers set it when streamed.
  streamedOverlayCache = null
  streamedOverlayKind = null
  const streamed = els.streamHiRes.checked && els.overlayOn.checked
  // Strategy A (streamed combined overlay): the overlay streams at the SAME
  // level as the base (co-registered, base grid) and is combined per block,
  // sampled by the base block's ray-march. Otherwise the overlay is the legacy
  // coarse resliced map.
  // ?level=N pins the base to that pyramid level (e.g. 0 = full-res L0),
  // overriding the budget-based pick. Use with a large ?budgetGB.
  const pinned =
    forcedLevel != null
      ? levelsSorted(v).find((l) => l.level === forcedLevel)
      : undefined
  const bgLvl = pinned ?? streamLevel(v)
  const coarseLvl = overlayLevel(v) // window + z-score stats source
  loadedBgLevel = bgLvl.level
  loadedOvLevel = streamed ? bgLvl.level : coarseLvl.level
  els.mag.textContent = streamed
    ? `streaming L${bgLvl.level} · combined overlay…`
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
  const list = [createBackground(v, bgLvl, bgWin)]
  if (els.overlayOn.checked) {
    if (streamed) {
      // Only one streamed/chunked overlay renders at a time.
      list.push(
        els.rgbaCombine.checked
          ? // Two colored layers blended into one premultiplied-RGBA overlay.
            createRgbaCombinedOverlay(v, bgLvl, computeStats(scalars))
          : // Strategy A: scalar combined streamed overlay at the base level.
            createStreamedStatOverlay(v, bgLvl, computeStats(scalars)),
      )
    } else {
      // Two stacked resliced overlays (warm cores + cool surround).
      list.push(...createStatOverlays(v, coarseLvl, scalars))
    }
  }
  try {
    await nv.loadVolumes(list)
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  // The streamed combined overlay (strategy A) renders in both the 3D render
  // and 2D multiplanar slices, so honor the selected layout.
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

  // Auto-size the residency budget to the pinned level (if any) so the streamed
  // overlay holds its working set against the base; ?budgetGB still overrides.
  activeBudgetBytes = residencyBudgetFor(initial)

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
    maxTextureDimension3D: CHUNK_EDGE,
    maxChunkResidencyBytes: activeBudgetBytes,
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
    syncControls()
    if (current) void loadAll(current)
  })
  els.streamHiRes.addEventListener('change', () => {
    syncControls()
    if (current) void loadAll(current)
  })
  els.rgbaCombine.addEventListener('change', () => {
    syncControls()
    if (current) void loadAll(current)
  })
  // Clip the overlay with the base in the 3D render (vs. overlay showing through).
  els.clipOverlay.addEventListener('change', () => {
    if (nv) nv.clipPlaneOverlay = els.clipOverlay.checked
  })
  // 3D zoom (scene scale). Lets you zoom into the clipped interior (right-drag a
  // 3D-render tile to set the clip plane) without re-streaming.
  els.zoom.addEventListener('input', () => {
    if (!nv) return
    nv.scaleMultiplier = Number(els.zoom.value)
    nv.drawScene()
  })
  els.cmap.addEventListener('change', () => {
    // volumes[1] is the warm overlay (resliced) or the single streamed overlay.
    if (nv?.volumes[1]) void nv.setVolume(1, { colormap: els.cmap.value })
    renderHud()
  })
  // In the resliced mode the two overlays are real stacked volumes, so opacity is
  // live-settable: warm = volumes[1], cool = volumes[2]. The streamed modes bake
  // opacity into each chunk, so a slider change there re-streams on release.
  const isStreamed = (): boolean =>
    els.streamHiRes.checked && els.overlayOn.checked
  const applyOpacityLive = (): void => {
    if (!nv || isStreamed()) return
    if (nv.volumes[1]) void nv.setVolume(1, { opacity: warmOpacity() })
    if (nv.volumes[2]) void nv.setVolume(2, { opacity: coolOpacity() })
    renderHud()
  }
  // Streamed overlays bake opacity into each brick, so re-bake in place: update the
  // baked value, then drop the resident overlay bricks so niivue re-streams only the
  // blocks in the current frustum (the base volume stays resident). Fires on release
  // ('change') rather than every 'input' tick since each re-bake re-streams bricks.
  const rebakeIfStreamed = (): void => {
    if (!nv || !isStreamed()) return
    if (streamedOverlayKind === 'scalar') {
      if (nv.volumes[1]) nv.volumes[1].opacity = warmOpacity()
    } else if (streamedOverlayKind === 'rgba') {
      streamedOverlayCache?.clear()
      overlayFetched = new Set()
    }
    nv.rebakeChunkedOverlays()
    renderHud()
    pollStreamingHud()
  }
  els.opacityWarm.addEventListener('input', applyOpacityLive)
  els.opacityCool.addEventListener('input', applyOpacityLive)
  els.opacityWarm.addEventListener('change', rebakeIfStreamed)
  els.opacityCool.addEventListener('change', rebakeIfStreamed)

  syncControls()
  await loadAll(initial)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
