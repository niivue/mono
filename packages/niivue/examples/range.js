// Client-side chunk streaming demo for the NiiVue 3D viewer.
//
// Streams a chunked volume into NiiVue over plain HTTP, with no backend or data
// server -- only static file serving (the synthetic source uses HTTP 206 range
// requests on a single shard; the OME-Zarr source reads per-chunk objects via
// zarrita). Add `?backend=webgpu` to the URL to use the WebGPU renderer.
//
// Two sources, both bundled as static fixtures in public/:
//   - synthetic: a single shard (.bin) streamed one chunk at a time over Range
//   - omezarr:   a static OME-Zarr store read with zarrita (only scale2 bundled)

import * as zarr from 'zarrita'
import NiiVue, { chunkVolumeGrid, SLICE_TYPE } from '../src/index.ts'

const backend =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? 'webgpu'
    : 'webgl2'

const DEFAULT_RESIDENCY_BYTES = 768 * 1024 * 1024
const SYNTHETIC_DEFAULT_WINDOW = { min: 24, max: 210 }

// OME-Zarr stores discoverable under ${BASE_URL}omezarr/. `levels` lists the
// scale indices that may be present on disk, coarsest-first; the loader picks
// the first one whose array metadata actually resolves, so a store fetched at
// only its coarsest level still renders. `stent` is bundled (scale2 only);
// `pawpawsaurus` is downloaded on demand by scripts/fetch-pawpawsaurus.ts and
// is not checked in (see .gitignore).
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
}
const STREAMING_CHUNK_EDGE = 256
const STREAMING_CHUNK_HALO = [3, 3, 3]
const MAX_CHUNKS_PER_TILE = 256
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024

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

function assetUrl(path) {
  const base = import.meta.env.BASE_URL || '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(
    `${normalizedBase}${path.replace(/^\//, '')}`,
    window.location.href,
  ).toString()
}

const MANIFEST_URL = assetUrl('range-poc/synthetic-volume.json')

// --- byte cache for zarrita -------------------------------------------------

class ByteLruCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.entries = new Map()
    this.totalBytes = 0
  }

  has(key) {
    const hit = this.entries.has(key)
    if (hit) stats.cacheHits++
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
    stats.cacheBytes = this.totalBytes
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
  explode: el('explode'),
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
  const storeUrl = assetUrl(`omezarr/${storeDef.id}`)
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
  els.level.value = String(levels[0])
  return levels[0]
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

async function fetchByteRange(url, start, length) {
  const end = start + length - 1
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (!res.ok) {
    stats.failures++
    throw new Error(`GET ${url} range ${start}-${end} -> ${res.status}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  stats.wireBytes += bytes.byteLength

  if (res.status === 206) {
    stats.rangeHits++
    if (bytes.byteLength !== length) {
      stats.failures++
      throw new Error(
        `range ${start}-${end} returned ${bytes.byteLength}B, expected ${length}B`,
      )
    }
    recordRequest(`206 ${start}-${end}`)
    return bytes
  }

  stats.fullFileFallbacks++
  if (bytes.byteLength < end + 1) {
    stats.failures++
    throw new Error(
      `full response had ${bytes.byteLength}B, cannot slice ${start}-${end}`,
    )
  }
  recordRequest(`200 ${start}-${end}`)
  return bytes.slice(start, end + 1)
}

function recordRequest(label) {
  stats.lastRequests.unshift(label)
  if (stats.lastRequests.length > 5) stats.lastRequests.pop()
}

function createTrackedZarrFetch() {
  return async (request) => {
    const response = await fetch(request)
    const method = request.method || 'GET'
    const url = new URL(response.url || request.url)
    const pathname = url.pathname
    const range = request.headers.get('Range')
    const contentLength = Number(response.headers.get('Content-Length') ?? 0)

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
      `${response.status}${range ? ` ${range.replace(/^bytes=/, '')}` : ''} ${shortZarrPath(pathname)}`,
    )
    renderHud()
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
  if (dtype === 'uint8' || dtype === 'uint16') return dtype
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

async function loadOmezarrSource(storeDef, requestedLevel) {
  const storeUrl = assetUrl(`omezarr/${storeDef.id}`)
  const rootMeta = await fetchJson(`${storeUrl}/zarr.json`)
  const multiscale = multiscalesFromRoot(rootMeta)[0]

  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(),
  })
  const store = zarr.withByteCaching(baseStore, {
    cache: new ByteLruCache(ZARR_BYTE_CACHE_BYTES),
  })

  // Try the requested level first, then fall back to the store's configured
  // levels coarsest-first, using the first whose array metadata resolves. This
  // keeps a chosen level honored while staying robust to a store fetched at
  // only its coarsest level (e.g. `fetch-pawpawsaurus.ts --coarse`).
  const order = [
    ...(Number.isInteger(requestedLevel) ? [requestedLevel] : []),
    ...storeDef.levels.filter((lvl) => lvl !== requestedLevel),
  ]
  let level = -1
  let dataset = null
  let array = null
  for (const candidate of order) {
    const ds = multiscale?.datasets?.[candidate]
    if (!ds) continue
    try {
      // Open as zarr v3 explicitly: zarr.open() probes v2 metadata (.zarray /
      // .zattrs) first, which 404s noisily against a static OME-Zarr v3 store.
      array = await zarr.open.v3(zarr.root(store).resolve(`/${ds.path}`), {
        kind: 'array',
      })
      level = candidate
      dataset = ds
      break
    } catch {
      // Level not present on disk -- try the next one.
    }
  }
  if (!dataset || !array) {
    throw new Error(
      `No OME-Zarr level found for ${storeDef.id}. ` +
        'Did you run scripts/fetch-pawpawsaurus.ts?',
    )
  }

  const dtype = assertSupportedDtype(array.dtype)
  const dtypeInfo = niftiDatatype(dtype)
  const [shapeZ, shapeY, shapeX] = trailingSpatial(array.shape, 'shape')
  const [chunkZ, chunkY, chunkX] = trailingSpatial(array.chunks, 'chunks')
  const shape = [shapeX, shapeY, shapeZ]
  const chunkShape = [chunkX, chunkY, chunkZ]
  const chunkGrid = [
    Math.ceil(shape[0] / chunkShape[0]),
    Math.ceil(shape[1] / chunkShape[1]),
    Math.ceil(shape[2] / chunkShape[2]),
  ]

  return {
    kind: 'omezarr',
    id: `${storeDef.id}:level-${level}`,
    name: `${storeDef.name} L${level}`,
    shape,
    spacing: scaleFromDataset(dataset),
    dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: { ...storeDef.defaultWindow },
    chunkGrid,
    chunkShape,
    chunkCount: chunkGrid[0] * chunkGrid[1] * chunkGrid[2],
    sourceUrl: `${storeDef.id}/${dataset.path}`,
    transportLabel: 'OME-Zarr chunk objects',
    array,
    level,
    levelPath: dataset.path,
  }
}

async function loadActiveSource() {
  const store = currentStore()
  return store
    ? loadOmezarrSource(store, selectedLevel())
    : loadSyntheticSource()
}

function createChunkPlan(source) {
  if (source.kind === 'omezarr' && source.chunkCount > MAX_CHUNKS_PER_TILE) {
    const grid = estimateStreamingGrid(source.shape)
    return chunkVolumeGrid(
      source.shape,
      grid,
      STREAMING_CHUNK_EDGE,
      STREAMING_CHUNK_HALO,
    )
  }
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

function estimateStreamingGrid(shape) {
  return [
    Math.ceil(
      shape[0] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[0]),
    ),
    Math.ceil(
      shape[1] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[1]),
    ),
    Math.ceil(
      shape[2] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[2]),
    ),
  ]
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

    stats.requested.add(request.chunkIndex)
    const start = request.chunkIndex * source.chunkBytes
    const next = fetchByteRange(source.dataUrl, start, source.chunkBytes).then(
      (bytes) => {
        stats.completed.add(request.chunkIndex)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      },
    )
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
}

function createOmezarrChunkSource(source) {
  const cache = new Map()
  return (request) => {
    const cached = cache.get(request.chunkIndex)
    if (cached) return cached

    stats.requested.add(request.chunkIndex)
    const next = fetchOmezarrChunk(source, request)
      .then((bytes) => {
        stats.completed.add(request.chunkIndex)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      })
      .catch((err) => {
        stats.failures++
        renderHud()
        throw err
      })
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
}

async function fetchOmezarrChunk(source, request) {
  const [x0, y0, z0] = request.desc.texOrigin
  const [sx, sy, sz] = request.desc.texDims
  const selection = []
  for (let i = 0; i < source.array.shape.length - 3; i++) selection.push(0)
  selection.push(zarr.slice(z0, z0 + sz))
  selection.push(zarr.slice(y0, y0 + sy))
  selection.push(zarr.slice(x0, x0 + sx))

  const view = await zarr.get(source.array, selection)
  const bytes = bytesFromZarrView(view)
  const expectedBytes = sx * sy * sz * request.bytesPerVoxel
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `OME-Zarr chunk ${request.chunkIndex} returned ${bytes.byteLength}B, expected ${expectedBytes}B`,
    )
  }
  return bytes
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

function createStreamingVolume(source) {
  const win = parseWindow(source.defaultWindow)
  const chunkSource =
    source.kind === 'synthetic'
      ? createRangeChunkSource(source)
      : createOmezarrChunkSource(source)
  const vol = buildLogicalVolume({
    id: source.name,
    url:
      `client-chunk://${source.id}` +
      `?source=${source.kind}` +
      `&cm=${encodeURIComponent(els.colormap.value)}` +
      `&w=${win.min}-${win.max}` +
      `&explode=${els.explode.checked ? '1' : '0'}`,
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
  vol.chunkExplode = els.explode.checked
    ? { enabled: true, scale: [1.28, 1.28, 1.28] }
    : { enabled: false }
  return vol
}

function renderChunkStrip() {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const chunkCount = plan?.chunks.length ?? source.chunkCount
  const columns = Math.min(16, Math.max(4, gridDims[0] * gridDims[1]))
  els.chunkStrip.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
  const nodes = []
  for (let i = 0; i < chunkCount; i++) {
    const span = document.createElement('span')
    if (stats.completed.has(i)) span.className = 'hit'
    nodes.push(span)
  }
  els.chunkStrip.replaceChildren(...nodes)
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
  const chunkCount = plan?.chunks.length ?? source.chunkCount
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
  if (pollHandle !== 0) cancelAnimationFrame(pollHandle)
  const tick = () => {
    renderHud()
    pollHandle = requestAnimationFrame(tick)
  }
  pollHandle = requestAnimationFrame(tick)
}

function applyLayout() {
  if (!nv) return
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  renderHud()
}

async function reloadVolume(options = {}) {
  if (!nv) return
  hideFallback()
  stats = freshStats()
  try {
    if (options.reloadSource || !activeSource) {
      activeSource = null
      chunkPlan = null
      const source = await loadActiveSource()
      activeSource = source
      chunkPlan = createChunkPlan(source)
      // Reflect the level that actually loaded (may differ if the requested
      // one wasn't present and the loader fell back).
      if (source.kind === 'omezarr' && typeof source.level === 'number') {
        const value = String(source.level)
        if ([...els.level.options].some((o) => o.value === value)) {
          els.level.value = value
        }
      }
    }
    if (!activeSource) {
      throw new Error('No active source selected')
    }
    await nv.loadVolumes([createStreamingVolume(activeSource)])
    applyLayout()
  } catch (err) {
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
    // Keep the current window; the intensity range is the same across levels.
    void reloadVolume({ reloadSource: true })
  })
  els.layout.addEventListener('change', applyLayout)
  els.colormap.addEventListener('change', () => {
    void reloadVolume()
  })
  els.window.addEventListener('change', () => {
    void reloadVolume()
  })
  els.explode.addEventListener('change', () => {
    void reloadVolume()
  })
  els.reload.addEventListener('click', () => {
    void reloadVolume({ reloadSource: true })
  })

  await reloadVolume({ reloadSource: true })
  startHudPolling()
}

main().catch((err) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
