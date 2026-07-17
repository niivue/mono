// Client-side chunk streaming demo for the NiiVue 3D viewer.
//
// Streams a chunked volume into NiiVue over plain HTTP, with no backend or data
// server -- only static file serving (the synthetic source uses HTTP 206 range
// requests on a single shard; the OME-Zarr source reads per-chunk objects via
// zarrita). Add `?backend=webgpu` to the URL to use the WebGPU renderer.
//
// Two static-hosted source types:
//   - synthetic: a bundled shard streamed one chunk at a time over Range
//   - omezarr:   full upstream OME-Zarr stores read with zarrita

import * as zarr from 'zarrita'
import NiiVue, { chunkVolumeGrid, SLICE_TYPE } from '../src/index.ts'

const backend =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? 'webgpu'
    : 'webgl2'

// The coarse whole-volume floor is OFF by default: rendering a coarser pyramid
// level behind the fine chunks shows blocky "previous-level" detail in regions
// the fine chunks have not reached, which reads as an artifact. Pass ?floor to
// opt back in (A/B: see coarse backdrop vs. fine-only with empty gaps).
const NO_FLOOR = !new URLSearchParams(location.search).has('floor')
// Bumped each (re)load so a superseded load's late async work (e.g. the coarse
// floor build) is discarded instead of stomping a newer scene.
let reloadToken = 0

// Monotonic id stamped on every loaded source (`source.serial`). In-flight
// fetches from a superseded source resolve after we have reset `stats` and moved
// on, so they must NOT mutate the live counters (which would inflate the new
// source's numbers and light up the wrong chunk-strip cells). Every stats write
// is gated on `isLiveSerial(serial)`: the fetch's originating source must still
// be the active one. A same-source reload (window/colormap) keeps the serial, so
// its stragglers correctly update the current stats; a source switch changes it,
// so the old source's stragglers no-op.
let sourceSerial = 0
// Compare against the newest stamped serial (not activeSource, which is briefly
// null while a source-switch load is in flight — otherwise the array-open
// metadata fetches of the load that's currently newest would be dropped).
const isLiveSerial = (serial) => serial === sourceSerial

// The explode scale currently applied to the resident volume. Explode is gated
// on load-settle (see syncExplode): while chunks are still streaming the volume
// stays un-exploded (1), because the exploded "keep every brick resident" render
// path floods the load pipeline and janks the main thread. Reset to 1 on each
// (re)load; the slider's value is applied once in-flight/pending reach zero.
let appliedExplodeScale = 1

// GPU residency budget for the resident chunk set (RGBA + gradient textures;
// scalar upload textures are transient). niivue caps the per-frame working set
// to the chunks that fit this budget, so resident VRAM is hard-bounded to
// roughly this value. For a whole-volume 3D render the view-centred working set
// never moves off the centre as you rotate, so a too-small budget leaves you
// stuck on one section of the volume. 8 GB lets the bundled scivis levels that
// fit a desktop GPU resolve fully (e.g. all of pawpawsaurus L0 ~8 GB). Levels
// far larger than this (e.g. pig_heart L0 ~119 GB) still cannot render whole —
// they are region-of-interest only.
const DEFAULT_RESIDENCY_BYTES = 8192 * 1024 * 1024
const SYNTHETIC_DEFAULT_WINDOW = { min: 24, max: 210 }

// OME-Zarr stores resolve against VITE_OMEZARR_ASSET_BASE in production and
// ${BASE_URL}omezarr/ during local development. `levels` lists the scale
// indices that may be present, coarsest-first; the loader picks the first one
// whose array metadata resolves. `stent` is bundled locally (scale2 only); the
// others can be downloaded on demand with scripts/fetch-omezarr.ts.
const OMEZARR_STORES = {
  stent: {
    id: 'stent.ome.zarr',
    name: 'Stent OME-Zarr',
    levels: [2],
    defaultWindow: { min: 0, max: 1200 },
  },
  pawpawsaurus: {
    id: 'pawpawsaurus.ome.zarr',
    name: 'Pawpawsaurus OME-Zarr',
    levels: [3, 2, 1, 0],
    defaultWindow: { min: 30269, max: 56893 },
  },
  richtmyer_meshkov: {
    id: 'richtmyer_meshkov.ome.zarr',
    name: 'Richtmyer-Meshkov OME-Zarr',
    levels: [4, 3, 2, 1, 0],
    defaultWindow: { min: 0, max: 230 },
  },
  pig_heart: {
    id: 'pig_heart.ome.zarr',
    name: 'Pig Heart OME-Zarr (int16)',
    levels: [4, 3, 2, 1, 0],
    // Background is 0; tissue/structure sits ~400-750 (p90=400, p99=520,
    // p99.9=750 measured on scale3). calMin just above 0 makes empty space
    // transparent and ramps the structure across the gray scale.
    defaultWindow: { min: 40, max: 700 },
  },
}
const STREAMING_CHUNK_EDGE = 256
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024

// --- multi-LOD (crosshair-focused mixed-resolution) -------------------------
//
// For an OME-Zarr store with a pyramid we hand the pyramid to the core
// `nv.loadChunkedVolume(source, options)` API (a `ChunkedVolumeSource` adapter,
// see ZarrChunkedVolumeSource below), which builds a Neuroglancer-style octree:
// bricks near the crosshair render at the finest level, coarsening outward,
// under a brick/VRAM budget, and follow the crosshair automatically. This keeps
// a huge finest level (e.g. pig_heart L0 ~22 GB) renderable — only the focus
// region is ever finest — with the fetch dispatch/concurrency/retry all in core.
// The Level control becomes a max-detail cap (`minLevel`).
//
// Cap on brick count (< core MAX_CHUNKS_PER_TILE=256); the budget pass coarsens
// until the plan fits. Budget keeps resident VRAM ~this regardless of the level
// the user picks (kept below DEFAULT_RESIDENCY_BYTES so no planned brick evicts).
const MULTILOD_MAX_BRICKS = 240
const MULTILOD_BUDGET_BYTES = 2048 * 1024 * 1024
// The core NVChunkedVolume handle for the active OME-Zarr source (null for
// synthetic). Owns the focus-follow plan swaps; the demo drives its max-detail
// cap from the Level control and nudges it to re-plan on zoom/layout changes.
let activeCv = null

// --- logical-volume helpers (inlined from the demo glue) --------------------

function niftiDatatype(dtype) {
  switch (dtype) {
    case 'uint8':
      return { code: 2, bits: 8, displayMin: 0, displayMax: 255 }
    case 'int8':
      return { code: 256, bits: 8, displayMin: -128, displayMax: 127 }
    case 'uint16':
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
    case 'int16':
      return { code: 4, bits: 16, displayMin: -32768, displayMax: 32767 }
    case 'float32':
      return { code: 16, bits: 32, displayMin: 0, displayMax: 1 }
    default:
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
  }
}

// Build a depth-correct, axis-aligned NVImage from a level's shape + spacing.
// The affine is diag(spacing) with the voxel grid placed at the origin, so two
// volumes built this way that cover the same mm box (shape*spacing) register.
function buildLogicalVolume(o) {
  const { shape, spacing } = o
  const dims = [3, shape[0], shape[1], shape[2], 1, 1, 1, 1]
  const pixDims = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1]
  const affine = [
    [spacing[0], 0, 0, 0],
    [0, spacing[1], 0, 0],
    [0, 0, spacing[2], 0],
    [0, 0, 0, 1],
  ]
  const dimsMM = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ]
  const longest = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const matRAS = new Float32Array([
    spacing[0],
    0,
    0,
    0,
    0,
    spacing[1],
    0,
    0,
    0,
    0,
    spacing[2],
    0,
    0,
    0,
    0,
    1,
  ])
  const frac2mm = new Float32Array([
    dimsMM[0],
    0,
    0,
    0,
    0,
    dimsMM[1],
    0,
    0,
    0,
    0,
    dimsMM[2],
    0,
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
    1,
  ])
  const identity = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ])
  const minMM = [-0.5 * spacing[0], -0.5 * spacing[1], -0.5 * spacing[2]]
  const maxMM = [
    (shape[0] - 0.5) * spacing[0],
    (shape[1] - 0.5) * spacing[1],
    (shape[2] - 0.5) * spacing[2],
  ]
  return {
    name: o.id,
    id: o.id,
    url: o.url,
    img: o.img ?? null,
    hdr: {
      littleEndian: true,
      dim_info: 0,
      dims,
      pixDims,
      intent_p1: 0,
      intent_p2: 0,
      intent_p3: 0,
      intent_code: 0,
      datatypeCode: o.datatypeCode,
      numBitsPerVoxel: o.numBitsPerVoxel,
      slice_start: 0,
      vox_offset: 352,
      scl_slope: 1,
      scl_inter: 0,
      slice_end: 0,
      slice_code: 0,
      xyzt_units: 10,
      cal_max: o.calMax,
      cal_min: o.calMin,
      slice_duration: 0,
      toffset: 0,
      description: 'logical streamed volume',
      aux_file: '',
      qform_code: 0,
      sform_code: 1,
      quatern_b: 0,
      quatern_c: 0,
      quatern_d: 0,
      qoffset_x: 0,
      qoffset_y: 0,
      qoffset_z: 0,
      affine,
      intent_name: '',
      magic: 'n+1',
    },
    originalAffine: affine.map((row) => [...row]),
    dims: dims.slice(0, 4),
    nVox3D: shape[0] * shape[1] * shape[2],
    extentsMin: minMM,
    extentsMax: maxMM,
    calMin: o.calMin,
    calMax: o.calMax,
    robustMin: o.calMin,
    robustMax: o.calMax,
    globalMin: o.calMin,
    globalMax: o.calMax,
    pixDimsRAS: pixDims.slice(0, 4),
    dimsRAS: dims.slice(0, 4),
    permRAS: [1, 2, 3],
    matRAS,
    obliqueRAS: identity,
    frac2mm,
    frac2mmOrtho: frac2mm,
    extentsMinOrtho: minMM,
    extentsMaxOrtho: maxMM,
    mm2ortho: identity,
    img2RASstep: [1, shape[0], shape[0] * shape[1]],
    img2RASstart: [0, 0, 0],
    toRAS: identity,
    toRASvox: identity,
    mm000: minMM,
    mm100: [maxMM[0], minMM[1], minMM[2]],
    mm010: [minMM[0], maxMM[1], minMM[2]],
    mm001: [minMM[0], minMM[1], maxMM[2]],
    oblique_angle: 0,
    maxShearDeg: 0,
    volScale: [dimsMM[0] / longest, dimsMM[1] / longest, dimsMM[2] / longest],
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
    colormap: o.colormap,
    isTransparentBelowCalMin: o.isTransparentBelowCalMin ?? true,
    opacity: o.opacity ?? 1,
    modulateAlpha: 0,
    isColorbarVisible: false,
    isLegendVisible: false,
    colormapLabel: null,
    chunkSource: o.chunkSource,
    chunkOverlayOf: o.chunkOverlayOf,
    chunkOverlayOpacity: o.chunkOverlayOpacity,
  }
}

// --- asset URLs -------------------------------------------------------------

function resolveAssetUrl(path, base) {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(
    `${normalizedBase}${path.replace(/^\//, '')}`,
    window.location.href,
  ).toString()
}

function demoAssetUrl(path) {
  return resolveAssetUrl(path, import.meta.env.BASE_URL || '/')
}

function omezarrAssetUrl(path) {
  const upstreamBase = import.meta.env.VITE_OMEZARR_ASSET_BASE
  if (upstreamBase) return resolveAssetUrl(path, upstreamBase)
  const streamingBase = import.meta.env.VITE_STREAMING_ASSET_BASE
  if (streamingBase) return resolveAssetUrl(`omezarr/${path}`, streamingBase)
  return demoAssetUrl(`omezarr/${path}`)
}

const MANIFEST_URL = demoAssetUrl('range-poc/synthetic-volume.json')

// --- byte cache for zarrita -------------------------------------------------

class ByteLruCache {
  constructor(maxBytes, serial) {
    this.maxBytes = maxBytes
    this.entries = new Map()
    this.totalBytes = 0
    // Source serial this cache belongs to; its stats writes no-op once superseded.
    this.serial = serial
  }

  has(key) {
    const hit = this.entries.has(key)
    if (hit && isLiveSerial(this.serial)) stats.cacheHits++
    return hit
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value) {
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.entries.delete(key)
    }
    const bytes = value?.byteLength ?? 0
    this.entries.set(key, { value, bytes })
    this.totalBytes += bytes
    this.evict()
    if (isLiveSerial(this.serial)) stats.cacheBytes = this.totalBytes
  }

  evict() {
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey !== 'string') return
      const first = this.entries.get(firstKey)
      if (!first) return
      this.entries.delete(firstKey)
      this.totalBytes -= first.bytes
    }
  }
}

// --- DOM elements -----------------------------------------------------------

function el(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node
}

const els = {
  source: el('source'),
  level: el('level'),
  layout: el('layout'),
  colormap: el('colormap'),
  window: el('window'),
  zoom: el('zoom'),
  zoomVal: el('zoomVal'),
  explode: el('explode'),
  explodeVal: el('explodeVal'),
  blocks: el('blocks'),
  reload: el('reload'),
  canvas: el('nv-canvas'),
  hud: el('hud'),
  chunkStrip: el('chunkStrip'),
  fallback: el('fallback'),
}

let nv = null
let activeSource = null
let chunkPlan = null
let stats = freshStats()
let pollHandle = 0

function freshStats() {
  return {
    requested: new Set(),
    completed: new Set(),
    wireBytes: 0,
    decodedBytes: 0,
    rangeHits: 0,
    chunkObjectHits: 0,
    metadataHits: 0,
    cacheHits: 0,
    cacheBytes: 0,
    fullFileFallbacks: 0,
    failures: 0,
    lastRequests: [],
  }
}

function relativeUrl(baseUrl, relative) {
  return new URL(relative, new URL(baseUrl, window.location.href)).toString()
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function html(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseWindow(fallback) {
  const parts = els.window.value.split(',').map((part) => Number(part.trim()))
  const min = parts[0]
  const max = parts[1]
  if (
    parts.length !== 2 ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max
  ) {
    return fallback
  }
  return { min, max }
}

// The source <select> value is either 'synthetic' or an OME-Zarr store key.
function currentStore() {
  return OMEZARR_STORES[els.source.value] ?? null
}

function showFallback(message) {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback() {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

// Let the user drag a floating panel (the HUD) out of the way of the volume.
// Switches the element to left/top positioning and clamps it to the viewport.
function makeDraggable(node) {
  let dragging = null
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const rect = node.getBoundingClientRect()
    dragging = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    node.setPointerCapture(event.pointerId)
    node.classList.add('dragging')
  })
  node.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    const width = node.offsetWidth
    const height = node.offsetHeight
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - height)
    const x = Math.min(maxX, Math.max(0, event.clientX - dragging.offsetX))
    const y = Math.min(maxY, Math.max(0, event.clientY - dragging.offsetY))
    node.style.left = `${x}px`
    node.style.top = `${y}px`
    node.style.right = 'auto'
    node.style.bottom = 'auto'
  })
  const end = (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    dragging = null
    node.classList.remove('dragging')
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
}

// Probe a store's configured levels and return those whose array metadata
// actually resolves on disk, coarsest-first. Used to populate the Level
// control so the user can only pick levels that have been fetched.
async function presentLevels(storeDef) {
  const storeUrl = omezarrAssetUrl(storeDef.id)
  const rootMeta = await fetchJson(`${storeUrl}/zarr.json`)
  const multiscale = multiscalesFromRoot(rootMeta)[0]
  const found = []
  for (const candidate of storeDef.levels) {
    const ds = multiscale?.datasets?.[candidate]
    if (!ds) continue
    const res = await fetch(`${storeUrl}/${ds.path}/zarr.json`, {
      method: 'HEAD',
    })
    if (res.ok) found.push(candidate)
  }
  return found
}

// Populate the Level <select> for the current source. Synthetic has no
// pyramid, so the control is disabled with a single "n/a" entry. For an
// OME-Zarr store, list the levels present on disk (coarsest-first) and select
// the coarsest by default. Returns the selected level (or null for synthetic).
async function refreshLevelControl() {
  const store = currentStore()
  if (!store) {
    els.level.replaceChildren(new Option('n/a', ''))
    els.level.disabled = true
    return null
  }
  let levels = []
  try {
    levels = await presentLevels(store)
  } catch {
    levels = []
  }
  if (levels.length === 0) {
    els.level.replaceChildren(new Option('none', ''))
    els.level.disabled = true
    return null
  }
  els.level.replaceChildren(
    ...levels.map((lvl) => new Option(`L${lvl}`, String(lvl))),
  )
  els.level.disabled = levels.length < 2
  // `levels` is coarsest-first. The Level control is a multi-LOD max-detail cap,
  // so default to the FINEST ("allow full detail at the crosshair") — picking a
  // coarser level caps how fine the octree may go anywhere.
  const finest = levels[levels.length - 1]
  els.level.value = String(finest)
  return finest
}

function selectedLevel() {
  const value = Number(els.level.value)
  return Number.isInteger(value) ? value : null
}

function formatWindow(win) {
  return `${win.min},${win.max}`
}

function setDefaultWindowForSelectedSource() {
  const store = currentStore()
  els.window.value = formatWindow(
    store ? store.defaultWindow : SYNTHETIC_DEFAULT_WINDOW,
  )
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return await res.json()
}

async function fetchManifest() {
  return fetchJson(MANIFEST_URL)
}

// `serial` is the originating source's serial; stats writes are gated on it so a
// superseded source's in-flight range fetch cannot mutate the live counters.
async function fetchByteRange(serial, url, start, length) {
  const end = start + length - 1
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (!res.ok) {
    if (isLiveSerial(serial)) stats.failures++
    throw new Error(`GET ${url} range ${start}-${end} -> ${res.status}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  const live = isLiveSerial(serial)
  if (live) stats.wireBytes += bytes.byteLength

  if (res.status === 206) {
    if (live) stats.rangeHits++
    if (bytes.byteLength !== length) {
      if (live) stats.failures++
      throw new Error(
        `range ${start}-${end} returned ${bytes.byteLength}B, expected ${length}B`,
      )
    }
    recordRequest(serial, `206 ${start}-${end}`)
    return bytes
  }

  if (live) stats.fullFileFallbacks++
  if (bytes.byteLength < end + 1) {
    if (live) stats.failures++
    throw new Error(
      `full response had ${bytes.byteLength}B, cannot slice ${start}-${end}`,
    )
  }
  recordRequest(serial, `200 ${start}-${end}`)
  return bytes.slice(start, end + 1)
}

function recordRequest(serial, label) {
  if (!isLiveSerial(serial)) return
  stats.lastRequests.unshift(label)
  if (stats.lastRequests.length > 5) stats.lastRequests.pop()
}

function createTrackedZarrFetch(serial) {
  return async (request) => {
    const response = await fetch(request)
    const method = request.method || 'GET'
    const url = new URL(response.url || request.url)
    const pathname = url.pathname
    const range = request.headers.get('Range')
    const contentLength = Number(response.headers.get('Content-Length') ?? 0)

    // Discard tracking from a superseded source's in-flight zarr fetches so they
    // don't inflate the current source's HUD counters.
    if (!isLiveSerial(serial)) return response

    if (
      method !== 'HEAD' &&
      Number.isFinite(contentLength) &&
      contentLength > 0
    ) {
      stats.wireBytes += contentLength
    }
    if (response.status === 206) {
      stats.rangeHits++
    } else if (response.status === 200 && method !== 'HEAD') {
      if (pathname.includes('/c/')) {
        stats.chunkObjectHits++
      } else {
        stats.metadataHits++
      }
    }
    if (!response.ok && response.status !== 404) {
      stats.failures++
    }

    recordRequest(
      serial,
      `${response.status}${range ? ` ${range.replace(/^bytes=/, '')}` : ''} ${shortZarrPath(pathname)}`,
    )
    // A multi-LOD load fires thousands of native zarr fetches; the throttled HUD
    // poll refreshes the panel, so don't rebuild it per fetch.
    return response
  }
}

function shortZarrPath(pathname) {
  const marker = '.ome.zarr/'
  const idx = pathname.indexOf(marker)
  if (idx >= 0) return pathname.slice(idx + marker.length)
  return pathname.split('/').filter(Boolean).slice(-5).join('/')
}

function multiscalesFromRoot(meta) {
  return meta.attributes?.ome?.multiscales ?? meta.attributes?.multiscales ?? []
}

function scaleFromDataset(dataset) {
  const scale = dataset.coordinateTransformations?.find(
    (transform) => transform.type === 'scale',
  )?.scale
  if (!scale || scale.length < 3) return [1, 1, 1]
  const spatial = scale.slice(-3)
  return [spatial[2], spatial[1], spatial[0]]
}

function trailingSpatial(nums, label) {
  if (nums.length < 3) {
    throw new Error(`${label} has ${nums.length} dimension(s), expected 3D`)
  }
  const spatial = nums.slice(-3)
  return [spatial[0], spatial[1], spatial[2]]
}

function assertSupportedDtype(dtype) {
  if (dtype === 'uint8' || dtype === 'uint16' || dtype === 'int16') return dtype
  throw new Error(`OME-Zarr dtype '${dtype}' is not supported by this demo`)
}

async function loadSyntheticSource() {
  const manifest = await fetchManifest()
  const dtypeInfo = niftiDatatype(manifest.dtype)
  return {
    kind: 'synthetic',
    id: manifest.id,
    name: manifest.name,
    shape: manifest.shape,
    spacing: manifest.spacing,
    dtype: manifest.dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: { ...SYNTHETIC_DEFAULT_WINDOW },
    chunkGrid: manifest.chunkGrid,
    chunkShape: manifest.chunkShape,
    chunkCount: manifest.chunkCount,
    sourceUrl: manifest.dataUrl,
    transportLabel: 'single shard + HTTP Range',
    dataUrl: relativeUrl(MANIFEST_URL, manifest.dataUrl),
    chunkBytes: manifest.chunkBytes,
  }
}

async function loadOmezarrSource(storeDef, serial) {
  const storeUrl = omezarrAssetUrl(storeDef.id)
  const rootMeta = await fetchJson(`${storeUrl}/zarr.json`)
  const multiscale = multiscalesFromRoot(rootMeta)[0]

  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(serial),
  })
  const store = zarr.withByteCaching(baseStore, {
    cache: new ByteLruCache(ZARR_BYTE_CACHE_BYTES, serial),
  })

  // Open a single pyramid level as a zarr v3 array (v2 probing 404s noisily on a
  // static v3 store). Returns null if the level isn't present on disk.
  const openLevel = async (candidate) => {
    const ds = multiscale?.datasets?.[candidate]
    if (!ds) return null
    try {
      const arr = await zarr.open.v3(zarr.root(store).resolve(`/${ds.path}`), {
        kind: 'array',
      })
      const [sz, sy, sx] = trailingSpatial(arr.shape, 'shape')
      return {
        level: candidate,
        dataset: ds,
        array: arr,
        shape: [sx, sy, sz],
        spacing: scaleFromDataset(ds),
      }
    } catch {
      return null // level not present on disk
    }
  }

  // Open EVERY present level (the octree fetches each brick from its own level).
  // `opened` is sorted finest-first so opened[0] is the common reference grid.
  const opened = []
  for (const candidate of [...storeDef.levels].sort((a, b) => a - b)) {
    const lvl = await openLevel(candidate)
    if (lvl) opened.push(lvl)
  }
  if (opened.length === 0) {
    throw new Error(
      `No OME-Zarr level found for ${storeDef.id}. ` +
        `Did you run scripts/fetch-omezarr.ts --name=${els.source.value}?`,
    )
  }
  opened.sort((a, b) => a.level - b.level) // finest-first
  // Primary geometry = the finest present level (the common grid).
  const primary = opened[0]
  const { level, dataset, array, shape, spacing } = primary

  const dtype = assertSupportedDtype(array.dtype)
  const dtypeInfo = niftiDatatype(dtype)
  const [chunkZ, chunkY, chunkX] = trailingSpatial(array.chunks, 'chunks')
  const chunkShape = [chunkX, chunkY, chunkZ]
  const chunkGrid = [
    Math.ceil(shape[0] / chunkShape[0]),
    Math.ceil(shape[1] / chunkShape[1]),
    Math.ceil(shape[2] / chunkShape[2]),
  ]

  return {
    kind: 'omezarr',
    id: `${storeDef.id}:multilod`,
    name: `${storeDef.name} multi-LOD`,
    shape,
    spacing,
    dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: { ...storeDef.defaultWindow },
    chunkGrid,
    chunkShape,
    chunkCount: chunkGrid[0] * chunkGrid[1] * chunkGrid[2],
    sourceUrl: `${storeDef.id}/${dataset.path}`,
    transportLabel: 'OME-Zarr multi-LOD octree',
    array,
    // All present levels, finest-first: {level, array, shape, spacing, dataset}.
    // The multi-LOD chunk source dispatches each brick to levels[sourceLevel].
    levels: opened,
    level,
    levelPath: dataset.path,
    // Kept so a coarse whole-volume "floor" can be built from the coarsest
    // present level (see buildCoarseFloorVolume): the 3D render shows that
    // coarse detail in regions whose fine chunks have not streamed in yet.
    store,
    multiscale,
    storeDef,
  }
}

// Build a small in-memory whole-volume from the coarsest present pyramid level
// of an OME-Zarr source, to use as niivue's base "coarse floor". The 3D render
// draws this behind any not-yet-resident fine chunk, so a huge level (whose
// full chunk set can't fit the residency budget) still shows the whole volume
// immediately instead of rendering blank. Returns null if no coarser level than
// the active one is available, or on any error (the floor is best-effort).
async function buildCoarseFloorVolume(source) {
  try {
    const coarsest = Math.max(...source.storeDef.levels)
    if (coarsest <= source.level) return null // active level is already coarsest
    const ds = source.multiscale?.datasets?.[coarsest]
    if (!ds) return null
    const arr = await zarr.open.v3(
      zarr.root(source.store).resolve(`/${ds.path}`),
      { kind: 'array' },
    )
    const view = await zarr.get(arr, null) // whole (small) coarse level
    const img = bytesFromZarrView(view)
    const [sz, sy, sx] = trailingSpatial(arr.shape, 'coarse shape')
    const win = parseWindow(source.defaultWindow)
    return buildLogicalVolume({
      id: `${source.id}:floor`,
      url: `client-chunk://${source.id}/floor`,
      shape: [sx, sy, sz],
      spacing: scaleFromDataset(ds),
      datatypeCode: source.datatypeCode,
      numBitsPerVoxel: source.numBitsPerVoxel,
      calMin: win.min,
      calMax: win.max,
      colormap: els.colormap.value,
      img,
    })
  } catch (err) {
    console.warn('coarse floor unavailable:', err)
    return null
  }
}

async function loadActiveSource() {
  // Stamp this load with a fresh serial so its fetches/cache can tell whether
  // they are still the active source when they resolve (see isLiveSerial).
  const serial = ++sourceSerial
  const store = currentStore()
  const source = store
    ? await loadOmezarrSource(store, serial)
    : await loadSyntheticSource()
  source.serial = serial
  return source
}

// A ChunkedVolumeSource adapter over an opened OME-Zarr pyramid. Exposes the
// finest-first levels and reads a voxel region of one level with zarrita; the
// core `nv.loadChunkedVolume` owns plan-building, per-level dispatch,
// concurrency, retry, dedup, and residency. This adapter only fetches bytes
// (plus demo telemetry so the HUD counts requested/completed/decoded).
function createZarrChunkedSource(source) {
  return {
    datatypeCode: source.datatypeCode,
    levels: source.levels.map((l) => ({
      level: l.level,
      shape: l.shape,
      spacing: l.spacing,
    })),
    async fetchChunk({ levelIndex, texOrigin, texDims, bytesPerVoxel }) {
      const key = `${levelIndex}|${texOrigin.join(',')}|${texDims.join(',')}`
      if (isLiveSerial(source.serial)) stats.requested.add(key)
      try {
        const bytes = await readOmezarrRegion(
          source.levels[levelIndex],
          texOrigin,
          texDims,
          bytesPerVoxel,
        )
        if (isLiveSerial(source.serial)) {
          stats.completed.add(key)
          stats.decodedBytes += bytes.byteLength
        }
        return bytes
      } catch (err) {
        // Surface the failure in the HUD/console (the signal we used to spot the
        // L0 request flood) before rethrowing. Retry now lives in core, so this
        // counts failed ATTEMPTS: a transient blip the core loader later retries
        // successfully still ticks the counter — a growing number means trouble.
        if (isLiveSerial(source.serial)) {
          stats.failures++
          recordRequest(source.serial, `ERR ${key}`)
        }
        console.error(
          `OME-Zarr region ${key} failed:`,
          err instanceof Error ? err.message : err,
        )
        throw err
      }
    },
  }
}

// The finest-first level index of the Level dropdown's picked pyramid level,
// used as the multi-LOD max-detail cap (minLevel). 0 = finest allowed.
function selectedLevelIndex(source) {
  const picked = selectedLevel()
  const idx = source.levels.findIndex((l) => l.level === picked)
  return idx < 0 ? 0 : idx
}

// Single-level chunk plan for the SYNTHETIC single-shard source (OME-Zarr goes
// through the core nv.loadChunkedVolume path). Its native grid fits one tile.
function createChunkPlan(source) {
  const plan = chunkVolumeGrid(
    source.shape,
    source.chunkGrid,
    Math.max(...source.chunkShape),
    [0, 0, 0],
  )
  if (plan.chunks.length !== source.chunkCount) {
    throw new Error(
      `chunk plan produced ${plan.chunks.length} chunks, source has ${source.chunkCount}`,
    )
  }
  return plan
}

function createRangeChunkSource(source) {
  const cache = new Map()
  return (request) => {
    const cached = cache.get(request.chunkIndex)
    if (cached) return cached

    const desc = request.desc
    const requestedBytes =
      desc.texDims[0] *
      desc.texDims[1] *
      desc.texDims[2] *
      request.bytesPerVoxel
    if (requestedBytes !== source.chunkBytes) {
      throw new Error(
        `chunk ${request.chunkIndex} asks for ${requestedBytes}B, fixture chunks are ${source.chunkBytes}B`,
      )
    }

    if (isLiveSerial(source.serial)) stats.requested.add(request.chunkIndex)
    const start = request.chunkIndex * source.chunkBytes
    const next = fetchByteRange(
      source.serial,
      source.dataUrl,
      start,
      source.chunkBytes,
    ).then((bytes) => {
      if (isLiveSerial(source.serial)) {
        stats.completed.add(request.chunkIndex)
        stats.decodedBytes += bytes.byteLength
        renderHud()
      }
      return bytes
    })
    // Only dedup concurrent in-flight requests; drop the entry once settled so
    // resolved chunk buffers are not retained. niivue manages residency and
    // re-requests an evicted chunk through this source when it is visible again,
    // so caching every resolved buffer here would leak the whole volume (OOM on
    // large levels).
    cache.set(request.chunkIndex, next)
    next.finally(() => {
      if (cache.get(request.chunkIndex) === next) {
        cache.delete(request.chunkIndex)
      }
    })
    renderHud()
    return next
  }
}

// Read one region of one pyramid level with zarrita, clamped + zero-padded to
// exactly texDims (the ChunkedVolumeSource.fetchChunk contract). texOrigin/
// texDims are in that level's own voxel grid. The core NVChunkedVolume wraps
// this with concurrency/retry/dedup, so this is a plain read.
async function readOmezarrRegion(level, texOrigin, texDims, bpv) {
  const [x0, y0, z0] = texOrigin
  const [sx, sy, sz] = texDims
  const array = level.array
  const [shapeX, shapeY, shapeZ] = level.shape
  // A streaming tile near a volume edge can extend past the array bounds; clamp
  // the read to the real extent, then zero-pad back up to the requested texDims
  // so the texture upload still gets a full [sx,sy,sz] brick (out-of-bounds =
  // fill value 0). zarr.slice past the end would otherwise return a short region
  // that mismatches the expected byte count.
  const ez = Math.min(z0 + sz, shapeZ)
  const ey = Math.min(y0 + sy, shapeY)
  const ex = Math.min(x0 + sx, shapeX)
  const rz = ez - z0
  const ry = ey - y0
  const rx = ex - x0

  const selection = []
  for (let i = 0; i < array.shape.length - 3; i++) selection.push(0)
  selection.push(zarr.slice(z0, ez))
  selection.push(zarr.slice(y0, ey))
  selection.push(zarr.slice(x0, ex))

  const view = await zarr.get(array, selection)
  const region = bytesFromZarrView(view)
  const expectedBytes = sx * sy * sz * bpv

  // Fast path: the read already covers the full requested brick.
  if (rz === sz && ry === sy && rx === sx) {
    if (region.byteLength !== expectedBytes) {
      throw new Error(
        `OME-Zarr region ${texOrigin.join(',')} returned ${region.byteLength}B, expected ${expectedBytes}B`,
      )
    }
    return region
  }

  // Edge tile: copy the clamped [rz,ry,rx] region into a zero-filled [sz,sy,sx]
  // brick. Layout is z-major then y then x (row of rx*bpv bytes per y line).
  const out = new Uint8Array(expectedBytes)
  const rowBytes = rx * bpv
  const dstRowStride = sx * bpv
  const dstPlaneStride = sy * dstRowStride
  let src = 0
  for (let zz = 0; zz < rz; zz++) {
    const dstPlane = zz * dstPlaneStride
    for (let yy = 0; yy < ry; yy++) {
      const dst = dstPlane + yy * dstRowStride
      out.set(region.subarray(src, src + rowBytes), dst)
      src += rowBytes
    }
  }
  return out
}

function bytesFromZarrView(view) {
  if (typeof view !== 'object' || view === null || !('data' in view)) {
    throw new Error('OME-Zarr selection returned a scalar instead of a chunk')
  }
  const data = view.data
  if (!ArrayBuffer.isView(data)) {
    throw new Error('OME-Zarr chunk data is not buffer-backed')
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

// Current uniform explode scale from the slider (1 = no gap between bricks).
function explodeScale() {
  return Math.max(1, Number(els.explode.value) || 1)
}

// Build the streamed NVImage for the SYNTHETIC single-shard source (OME-Zarr
// goes through the core nv.loadChunkedVolume path instead).
function createStreamingVolume(source) {
  const win = parseWindow(source.defaultWindow)
  const chunkSource = createRangeChunkSource(source)
  const vol = buildLogicalVolume({
    id: source.name,
    url:
      `client-chunk://${source.id}` +
      `?source=${source.kind}` +
      `&cm=${encodeURIComponent(els.colormap.value)}` +
      `&w=${win.min}-${win.max}` +
      `&explode=${explodeScale().toFixed(2)}`,
    shape: source.shape,
    spacing: source.spacing,
    datatypeCode: source.datatypeCode,
    numBitsPerVoxel: source.numBitsPerVoxel,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
    chunkSource,
  })
  vol.chunkPlan = chunkPlan ?? undefined
  // Start un-exploded; syncExplode applies the slider's explode once the stream
  // settles (exploding mid-stream janks the main thread).
  vol.chunkExplode = { enabled: false }
  return vol
}

// --- zoom + 3D block-outline overlay -----------------------------------------

// Outline color per source LOD level (finest = hot, coarser = cool). range.html
// streams a single level, so most blocks share a color; sourceLevel is honored
// when a plan carries it.
const BLOCK_LEVEL_COLORS = [
  [1, 0.2, 0.2, 1],
  [1, 0.6, 0.1, 1],
  [1, 1, 0.25, 1],
  [0.35, 1, 0.35, 1],
  [0.35, 0.7, 1, 1],
]

// mm extents of the active volume. Matches buildLogicalVolume: voxel centres sit
// at (i + 0.5) * spacing, so the box spans [-0.5, dim - 0.5] * spacing per axis.
function volumeExtents(source) {
  const [sx, sy, sz] = source.spacing
  const [nx, ny, nz] = source.shape
  return {
    min: [-0.5 * sx, -0.5 * sy, -0.5 * sz],
    max: [(nx - 0.5) * sx, (ny - 0.5) * sy, (nz - 0.5) * sz],
  }
}

// The focused sub-box at the current zoom: the central 1/zoom fraction of the
// volume on each axis (the region the zoomed-in 2D views frame). At zoom 1 this
// is the whole volume, so nothing is restricted.
function focusRoi(source, zoom) {
  const { min, max } = volumeExtents(source)
  const roiMin = [0, 0, 0]
  const roiMax = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const centre = (min[a] + max[a]) / 2
    const half = (max[a] - min[a]) / 2 / Math.max(1, zoom)
    roiMin[a] = centre - half
    roiMax[a] = centre + half
  }
  return { min: roiMin, max: roiMax }
}

function boxesIntersect(aMin, aMax, bMin, bMax) {
  for (let a = 0; a < 3; a++) {
    if (aMax[a] < bMin[a] || aMin[a] > bMax[a]) return false
  }
  return true
}

// One outline box per streamed chunk, in mm. When zoomed in, restrict to the
// chunks intersecting the focus ROI so the outlines mark only the region under
// inspection instead of covering the whole 3D render. When exploded, each box is
// shifted by the same per-brick offset the renderer applies (matching
// ChunkExplode.chunkExplodeOffsetFrac) so the outlines track the exploded bricks.
function computeBlockBoxes(source, plan, zoom, explode) {
  if (!source || !plan) return []
  const { min, max } = volumeExtents(source)
  const cs = source.shape
  const roi = zoom > 1.01 ? focusRoi(source, zoom) : null
  const es = explode > 1.001 ? explode : 1
  const toMM = (voxel, axis) =>
    min[axis] + (voxel / cs[axis]) * (max[axis] - min[axis])
  const boxes = []
  for (const c of plan.chunks) {
    // Unshifted (true volume-space) box drives the focus-ROI membership so
    // restriction stays stable regardless of the explode spacing.
    const bMin = [
      toMM(c.voxelOrigin[0], 0),
      toMM(c.voxelOrigin[1], 1),
      toMM(c.voxelOrigin[2], 2),
    ]
    const bMax = [
      toMM(c.voxelOrigin[0] + c.voxelDims[0], 0),
      toMM(c.voxelOrigin[1] + c.voxelDims[1], 1),
      toMM(c.voxelOrigin[2] + c.voxelDims[2], 2),
    ]
    if (roi && !boxesIntersect(bMin, bMax, roi.min, roi.max)) continue
    // Explode shift: offsetFrac = (centreFrac - 0.5) * (scale - 1) per axis.
    if (es > 1) {
      for (let a = 0; a < 3; a++) {
        const centreFrac = (c.voxelOrigin[a] + c.voxelDims[a] / 2) / cs[a]
        const shift = (centreFrac - 0.5) * (es - 1) * (max[a] - min[a])
        bMin[a] += shift
        bMax[a] += shift
      }
    }
    const level = c.sourceLevel ?? 0
    boxes.push({
      min: bMin,
      max: bMax,
      color: BLOCK_LEVEL_COLORS[Math.min(level, BLOCK_LEVEL_COLORS.length - 1)],
      thickness: level === 0 ? 2 : 1,
    })
  }
  return boxes
}

// Push the current zoom to the 2D pan/zoom and the 3D render scale, mark the
// focus ROI in 3D, then refresh the (optionally restricted) block outlines.
function applyZoom() {
  if (!nv) return
  const zoom = Number(els.zoom.value) || 1
  els.zoomVal.textContent = `${zoom.toFixed(1)}x`
  nv.pan2Dxyzmm = [0, 0, 0, zoom] // 2D multiplanar: zoom about the centre
  // Zoom the 3D render camera too (both layouts). The multi-LOD plan is already
  // focus-bounded, so magnifying the render no longer risks leaving out-of-focus
  // blocks unrequested — the finest bricks around the crosshair fill the view.
  nv.scaleMultiplier = zoom
  applyBlocks()
  // Zoom/layout changes the focus radius (radius:'auto' reads nv zoom + sliceType),
  // so nudge the core handle to re-plan and swap.
  activeCv?.refocus()
}

// Show or hide every block visualization together, gated on the "blocks" toggle:
// the per-chunk outline boxes, the zoom focus-region box, and the loaded-chunks
// indicator strip (which sits over a corner tile). All are cleared when the
// toggle is off so nothing overlays the render.
function applyBlocks() {
  if (!nv) return
  const show = els.blocks.checked
  const zoom = Number(els.zoom.value) || 1
  nv.lodBoxes =
    show && activeSource && chunkPlan
      ? computeBlockBoxes(activeSource, chunkPlan, zoom, appliedExplodeScale)
      : null
  nv.focusBox =
    show && activeSource && zoom > 1.01
      ? {
          ...focusRoi(activeSource, zoom),
          color: [1, 0.6, 0.1, 1],
          thickness: 2,
        }
      : null
  els.chunkStrip.style.display = show ? 'grid' : 'none'
  nv.drawScene()
}

// Reconcile the resident volume's explode with the slider. The renderer reads
// vol.chunkExplode every frame, so this is a live update (no re-stream). Applied
// while streaming too: the exploded render requests every brick each frame, which
// used to flood the load, but skipping the per-chunk gradient pass when unlit
// (see the core gradient gate) removed that cost, so bricks can stream in already
// exploded. Called on slider input and every HUD-poll frame (so it re-applies
// after a reload resets appliedExplodeScale); a no-op when already in the target
// state, so per-frame calls are cheap.
function syncExplode() {
  if (!nv) return
  const vol = nv.volumes?.[0]
  if (!vol) return
  const desired = explodeScale()
  if (desired === appliedExplodeScale) return
  appliedExplodeScale = desired
  vol.chunkExplode =
    desired > 1.001
      ? { enabled: true, scale: [desired, desired, desired] }
      : { enabled: false }
  applyBlocks()
}

// Slider handler: reflect the target value in the label immediately and try to
// apply it (only takes effect once the stream has settled).
function applyExplode() {
  if (!nv) return
  els.explodeVal.textContent = `${explodeScale().toFixed(2)}x`
  syncExplode()
}

// Built strip cells, reused across updates. Recreating every cell each poll (and
// formerly every render frame) forced a DOM reflow that janked rotation; instead
// build once when the chunk layout changes, then just toggle the 'hit' class.
let stripSpans = []
let stripKey = ''

function renderChunkStrip() {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  const gridDims = plan?.gridDims ?? source.chunkGrid
  // The strip visualizes viewer BRICKS. For OME-Zarr, source.chunkCount is the
  // NATIVE zarr-chunk count (can be 100k+ for a thin-Z finest level), so fall
  // back to the plan's brick count and hard-cap it — spreading 100k <span>s into
  // replaceChildren blows the call stack.
  const chunkCount = Math.min(plan?.chunks.length ?? 0, 4096)
  const columns = Math.min(16, Math.max(4, gridDims[0] * gridDims[1]))
  const key = `${chunkCount}:${columns}`
  if (key !== stripKey) {
    els.chunkStrip.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
    stripSpans = Array.from({ length: chunkCount }, () =>
      document.createElement('span'),
    )
    els.chunkStrip.replaceChildren(...stripSpans)
    stripKey = key
  }
  for (let i = 0; i < stripSpans.length; i++) {
    const hit = stats.completed.has(i)
    const cls = hit ? 'hit' : ''
    if (stripSpans[i].className !== cls) stripSpans[i].className = cls
  }
}

function httpSummary() {
  if (stats.rangeHits > 0) {
    return `<span class="ok">${stats.rangeHits} range 206</span>`
  }
  if (stats.chunkObjectHits > 0) {
    return `<span class="ok">${stats.chunkObjectHits} chunk objects</span>`
  }
  if (stats.fullFileFallbacks > 0) {
    return `<span class="warn">${stats.fullFileFallbacks} full-file 200</span>`
  }
  if (stats.metadataHits > 0) {
    return `<span class="warn">${stats.metadataHits} metadata</span>`
  }
  return '<span class="warn">pending</span>'
}

function renderHud() {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const planChunkShape = plan ? chunkShapeFromPlan(plan) : source.chunkShape
  // Viewer BRICK count (not the OME-Zarr native chunk count); 0 until the plan
  // is built. Synthetic always has a plan, so the fallback only affects the
  // brief OME-Zarr load window.
  const chunkCount = plan?.chunks.length ?? source.chunkCount ?? 0
  const nativeRow =
    source.kind === 'omezarr'
      ? `<div class="row"><span class="key">zarr chunks</span><span>${source.chunkGrid.join(' x ')} @ ${source.chunkShape.join(' x ')}</span></div>`
      : ''
  const stream = nv?.chunkStreamStats()
  const failures =
    stats.failures > 0
      ? `<span class="bad">${stats.failures}</span>`
      : '<span class="ok">0</span>'
  els.hud.innerHTML = `
    <div class="title">${html(source.name)}</div>
    <div class="row"><span class="key">backend</span><span>${backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}</span></div>
    <div class="row"><span class="key">source</span><span>${html(source.sourceUrl)}</span></div>
    <div class="row"><span class="key">shape</span><span>${source.shape.join(' x ')} ${source.dtype}</span></div>
    <div class="row"><span class="key">viewer chunks</span><span>${gridDims.join(' x ')} @ ${planChunkShape.join(' x ')}</span></div>
    ${nativeRow}
    <div class="row"><span class="key">transport</span><span>${html(source.transportLabel)}</span></div>
    <div class="row"><span class="key">HTTP</span><span>${httpSummary()}</span></div>
    <div class="row"><span class="key">requested</span><span>${stats.requested.size} / ${chunkCount}</span></div>
    <div class="row"><span class="key">completed</span><span>${stats.completed.size} / ${chunkCount}</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(stats.wireBytes)}</span></div>
    <div class="row"><span class="key">decoded</span><span>${formatBytes(stats.decodedBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${stats.cacheHits} hits, ${formatBytes(stats.cacheBytes)}</span></div>
    <div class="row"><span class="key">resident</span><span>${stream ? `${stream.resident} resident, ${stream.pending} pending, ${stream.inFlight} in flight` : 'pending'}</span></div>
    <div class="row"><span class="key">failures</span><span>${failures}</span></div>
    <div class="row"><span class="key">last requests</span><span>${html(stats.lastRequests.join(' | ') || 'none')}</span></div>
  `
  renderChunkStrip()
}

function chunkShapeFromPlan(plan) {
  return plan.chunks.reduce(
    (max, chunk) => [
      Math.max(max[0], chunk.texDims[0]),
      Math.max(max[1], chunk.texDims[1]),
      Math.max(max[2], chunk.texDims[2]),
    ],
    [0, 0, 0],
  )
}

function startHudPolling() {
  if (pollHandle !== 0) clearInterval(pollHandle)
  // Throttled off the render frame (~8 Hz): the stats panel and chunk strip only
  // need a periodic refresh, and rebuilding the HUD every animation frame forced
  // a reflow that competed with the WebGL render and janked rotation. syncExplode
  // still engages a deferred explode within ~120 ms of the stream settling.
  pollHandle = setInterval(() => {
    // The core NVChunkedVolume swaps the plan as the crosshair moves; mirror the
    // current plan so the HUD/block outlines track it. Reset the per-plan
    // requested/completed region counts when the plan identity changes.
    if (activeCv) {
      const p = activeCv.currentPlan
      if (p !== chunkPlan) {
        chunkPlan = p
        stats.requested = new Set()
        stats.completed = new Set()
      }
    }
    renderHud()
    syncExplode()
  }, 120)
}

function applyLayout() {
  if (!nv) return
  nv.sliceType = Number(els.layout.value)
  // The render-camera zoom is layout-dependent (see applyZoom): switching to or
  // from the render view must update scaleMultiplier and re-frame so the newly
  // in-frustum blocks are requested (applyZoom -> applyBlocks -> drawScene).
  applyZoom()
  renderHud()
}

async function reloadVolume(options = {}) {
  if (!nv) return
  // Capture a load token BEFORE any await. Every UI control fires reloadVolume
  // unawaited, so rapid source/level/window/colormap/explode changes run
  // concurrently; a stale load must bail after each await instead of stomping
  // the newer scene (otherwise activeSource/chunkPlan and the displayed volume
  // can end up describing whichever load happens to finish last).
  const token = ++reloadToken
  hideFallback()
  stats = freshStats()
  // The fresh volume starts un-exploded; syncExplode re-applies the slider's
  // explode once this load settles.
  appliedExplodeScale = 1
  try {
    if (options.reloadSource || !activeSource) {
      activeCv?.dispose()
      activeCv = null
      activeSource = null
      chunkPlan = null
      const source = await loadActiveSource()
      if (token !== reloadToken) return
      activeSource = source
    }
    if (!activeSource) {
      throw new Error('No active source selected')
    }

    if (activeSource.kind === 'omezarr') {
      // OME-Zarr: hand the pyramid to the core crosshair-focused multi-LOD API.
      // It builds the streamed NVImage, the octree plan, the concurrency-bounded
      // per-level fetch dispatch, and follows the crosshair — all in core.
      const win = parseWindow(activeSource.defaultWindow)
      activeCv?.dispose()
      activeCv = await nv.loadChunkedVolume(
        createZarrChunkedSource(activeSource),
        {
          id: activeSource.name,
          name: activeSource.name,
          calMin: win.min,
          calMax: win.max,
          colormap: els.colormap.value,
          budgetBytes: MULTILOD_BUDGET_BYTES,
          maxBricks: MULTILOD_MAX_BRICKS,
          deviceLimit: STREAMING_CHUNK_EDGE,
          minLevel: selectedLevelIndex(activeSource),
        },
      )
      if (token !== reloadToken) {
        activeCv?.dispose()
        activeCv = null
        return
      }
      chunkPlan = activeCv.currentPlan
    } else {
      // Synthetic: single-shard streamed volume on the legacy grid path.
      chunkPlan = createChunkPlan(activeSource)
      await nv.loadVolumes([createStreamingVolume(activeSource)])
      if (token !== reloadToken) return
    }

    applyLayout()
    // loadVolumes resets the camera/zoom and drops any prior boxes; reapply the
    // current zoom, focus ROI, and block outlines for the freshly loaded plan.
    applyZoom()
    // The core octree already renders coarse away from the focus, so the coarse
    // whole-volume floor is off by default; ?floor opts it back in for A/B.
    if (activeSource.kind === 'omezarr' && !NO_FLOOR) {
      const floor = await buildCoarseFloorVolume(activeSource)
      if (token !== reloadToken) return
      await nv.setBaseCoarseFloor(floor)
    } else {
      await nv.setBaseCoarseFloor(null)
    }
  } catch (err) {
    if (token !== reloadToken) return
    showFallback(err instanceof Error ? err.message : String(err))
  }
}

async function main() {
  makeDraggable(els.hud)
  setDefaultWindowForSelectedSource()
  await refreshLevelControl()

  nv = new NiiVue({
    backend,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.MULTIPLANAR,
    maxTextureDimension3D: 256,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)

  els.source.addEventListener('change', async () => {
    setDefaultWindowForSelectedSource()
    await refreshLevelControl()
    void reloadVolume({ reloadSource: true })
  })
  els.level.addEventListener('change', () => {
    // The Level control is the multi-LOD max-detail cap; the pyramid is already
    // open, so just move the cap and let core re-plan + swap in place.
    if (activeCv && activeSource) {
      activeCv.setMaxDetail(selectedLevelIndex(activeSource))
    }
  })
  els.layout.addEventListener('change', applyLayout)
  els.colormap.addEventListener('change', () => {
    void reloadVolume()
  })
  els.window.addEventListener('change', () => {
    void reloadVolume()
  })
  // Explode is a render-time per-brick offset, not a data change, so update it
  // live on the resident volume instead of re-streaming.
  els.explode.addEventListener('input', applyExplode)
  els.zoom.addEventListener('input', applyZoom)
  els.blocks.addEventListener('change', applyBlocks)
  els.reload.addEventListener('click', () => {
    void reloadVolume({ reloadSource: true })
  })

  // Crosshair-follow (finest bricks track the crosshair) is owned by the core
  // NVChunkedVolume — no demo-side locationChange wiring needed.

  await reloadVolume({ reloadSource: true })
  startHudPolling()

  // Debug hook (?debug): expose live state so the multi-LOD plan can be
  // inspected without depending on the RAF-gated render (e.g. a per-level brick
  // tally). Read-only getters over the core NVChunkedVolume handle.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__r = {
      get nv() {
        return nv
      },
      get source() {
        return activeSource
      },
      get cv() {
        return activeCv
      },
      get plan() {
        return activeCv?.currentPlan ?? chunkPlan
      },
      get focus() {
        return activeCv?.focus ?? null
      },
      levelTally() {
        const t = {}
        for (const c of (activeCv?.currentPlan ?? chunkPlan)?.chunks ?? []) {
          const l = c.sourceLevel ?? 0
          t[l] = (t[l] ?? 0) + 1
        }
        return t
      },
      // Drive the focus directly (the programmatic crosshairPos setter doesn't
      // emit locationChange, so this exercises the core setFocus path).
      driveFocus(frac) {
        activeCv?.setFocus(frac)
      },
    }
  }
}

main().catch((err) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
