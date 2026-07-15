import NiiVue, {
  type ChunkPlan,
  chunkVolumeGrid,
  type NVImage,
  SLICE_TYPE,
  type VolumeChunkSource,
} from '@niivue/niivue'
import * as zarr from 'zarrita'
import { getBackendFromUrl } from './backend'
import {
  buildLogicalVolume,
  niftiDatatype,
  type Shape3,
} from './logical-volume'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
const MANIFEST_URL = assetUrl('range-poc/synthetic-volume.json')
const DEFAULT_RESIDENCY_BYTES = 768 * 1024 * 1024
const OMEZARR_ID = 'pawpawsaurus.ome.zarr'
const OMEZARR_NAME = 'Pawpawsaurus OME-Zarr'
const OMEZARR_DEFAULT_WINDOW: DisplayWindow = { min: 30269, max: 56893 }
const STREAMING_CHUNK_EDGE = 256
const STREAMING_CHUNK_HALO: Shape3 = [3, 3, 3]
const MAX_CHUNKS_PER_TILE = 256
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024

type SourceKind = 'synthetic' | 'omezarr'
type SupportedDtype = 'uint8' | 'uint16'
type ChunkRequest = Parameters<VolumeChunkSource>[0]
type ZarrFetchArray = zarr.Array<zarr.DataType, zarr.AsyncReadable>

interface RangeManifest {
  id: string
  name: string
  shape: Shape3
  spacing: Shape3
  dtype: 'uint8'
  chunkGrid: Shape3
  chunkShape: Shape3
  chunkBytes: number
  chunkCount: number
  byteLength: number
  dataUrl: string
  order: string
}

interface NgffCoordinateTransform {
  type: string
  scale?: number[]
  translation?: number[]
}

interface NgffDataset {
  path: string
  coordinateTransformations?: NgffCoordinateTransform[]
}

interface NgffMultiscale {
  datasets?: NgffDataset[]
}

interface OmezarrRootMetadata {
  attributes?: {
    multiscales?: NgffMultiscale[]
    ome?: {
      multiscales?: NgffMultiscale[]
    }
  }
}

interface DisplayWindow {
  min: number
  max: number
}

interface LoadedSourceBase {
  kind: SourceKind
  id: string
  name: string
  shape: Shape3
  spacing: Shape3
  dtype: SupportedDtype
  datatypeCode: number
  numBitsPerVoxel: number
  defaultWindow: DisplayWindow
  chunkGrid: Shape3
  chunkShape: Shape3
  chunkCount: number
  sourceUrl: string
  transportLabel: string
}

interface RangeSource extends LoadedSourceBase {
  kind: 'synthetic'
  dataUrl: string
  chunkBytes: number
}

interface OmezarrSource extends LoadedSourceBase {
  kind: 'omezarr'
  array: ZarrFetchArray
  level: number
  levelPath: string
}

type LoadedSource = RangeSource | OmezarrSource

interface RangeStats {
  requested: Set<number>
  completed: Set<number>
  wireBytes: number
  decodedBytes: number
  rangeHits: number
  chunkObjectHits: number
  metadataHits: number
  cacheHits: number
  cacheBytes: number
  fullFileFallbacks: number
  failures: number
  lastRequests: string[]
}

class ByteLruCache implements zarr.ByteCache {
  private readonly entries = new Map<
    string,
    { value: Uint8Array | undefined; bytes: number }
  >()
  private totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  has(key: string): boolean {
    const hit = this.entries.has(key)
    if (hit) stats.cacheHits++
    return hit
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Uint8Array | undefined): void {
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

  private evict(): void {
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

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  source: el<HTMLSelectElement>('source'),
  level: el<HTMLSelectElement>('level'),
  layout: el<HTMLSelectElement>('layout'),
  colormap: el<HTMLSelectElement>('colormap'),
  window: el<HTMLInputElement>('window'),
  explode: el<HTMLInputElement>('explode'),
  reload: el<HTMLButtonElement>('reload'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  chunkStrip: el<HTMLDivElement>('chunkStrip'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let activeSource: LoadedSource | null = null
let chunkPlan: ChunkPlan | null = null
let stats: RangeStats = freshStats()
let pollHandle = 0

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${path.replace(/^\//, '')}`
}

function freshStats(): RangeStats {
  return {
    requested: new Set<number>(),
    completed: new Set<number>(),
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

function relativeUrl(baseUrl: string, relative: string): string {
  return new URL(relative, new URL(baseUrl, window.location.href)).toString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseWindow(fallback: DisplayWindow): DisplayWindow {
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

function currentSourceKind(): SourceKind {
  return els.source.value === 'omezarr' ? 'omezarr' : 'synthetic'
}

function showFallback(message: string): void {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback(): void {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

function syncSourceControls(): void {
  const isOmezarr = currentSourceKind() === 'omezarr'
  els.level.disabled = !isOmezarr
}

function setDefaultWindowForSelectedSource(): void {
  els.window.value =
    currentSourceKind() === 'omezarr'
      ? formatWindow(OMEZARR_DEFAULT_WINDOW)
      : '24,210'
}

function initControlsFromUrl(): void {
  const params = new URLSearchParams(window.location.search)
  if (params.get('source') === 'omezarr') {
    els.source.value = 'omezarr'
  }
  const level = params.get('level')
  if (level && ['0', '1', '2', '3'].includes(level)) {
    els.level.value = level
  }
  setDefaultWindowForSelectedSource()
  syncSourceControls()
}

function updateUrlFromControls(): void {
  const url = new URL(window.location.href)
  const kind = currentSourceKind()
  url.searchParams.set('source', kind)
  if (kind === 'omezarr') {
    url.searchParams.set('level', els.level.value)
  } else {
    url.searchParams.delete('level')
  }
  window.history.replaceState(null, '', url)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

async function fetchManifest(): Promise<RangeManifest> {
  return fetchJson<RangeManifest>(MANIFEST_URL)
}

async function fetchByteRange(
  url: string,
  start: number,
  length: number,
): Promise<Uint8Array> {
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

function recordRequest(label: string): void {
  stats.lastRequests.unshift(label)
  if (stats.lastRequests.length > 5) stats.lastRequests.pop()
}

function createTrackedZarrFetch(): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
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

function shortZarrPath(pathname: string): string {
  const marker = '/zarr/'
  const idx = pathname.indexOf(marker)
  if (idx >= 0) return pathname.slice(idx + marker.length)
  return pathname.split('/').filter(Boolean).slice(-5).join('/')
}

function multiscalesFromRoot(meta: OmezarrRootMetadata): NgffMultiscale[] {
  return meta.attributes?.ome?.multiscales ?? meta.attributes?.multiscales ?? []
}

function formatWindow(win: DisplayWindow): string {
  return `${win.min},${win.max}`
}

function scaleFromDataset(dataset: NgffDataset): Shape3 {
  const scale = dataset.coordinateTransformations?.find(
    (transform) => transform.type === 'scale',
  )?.scale
  if (!scale || scale.length < 3) return [1, 1, 1]
  const spatial = scale.slice(-3)
  return [spatial[2], spatial[1], spatial[0]]
}

function trailingSpatial(
  nums: number[],
  label: string,
): [number, number, number] {
  if (nums.length < 3) {
    throw new Error(`${label} has ${nums.length} dimension(s), expected 3D`)
  }
  const spatial = nums.slice(-3)
  return [spatial[0], spatial[1], spatial[2]]
}

function assertSupportedDtype(dtype: string): SupportedDtype {
  if (dtype === 'uint8' || dtype === 'uint16') return dtype
  throw new Error(`OME-Zarr dtype '${dtype}' is not supported by this demo`)
}

async function loadSyntheticSource(): Promise<RangeSource> {
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
    defaultWindow: { min: 24, max: 210 },
    chunkGrid: manifest.chunkGrid,
    chunkShape: manifest.chunkShape,
    chunkCount: manifest.chunkCount,
    sourceUrl: manifest.dataUrl,
    transportLabel: 'single shard + HTTP Range',
    dataUrl: relativeUrl(MANIFEST_URL, manifest.dataUrl),
    chunkBytes: manifest.chunkBytes,
  }
}

async function loadOmezarrSource(): Promise<OmezarrSource> {
  const level = Number(els.level.value)
  const storeUrl = new URL(
    `/zarr/${OMEZARR_ID}`,
    window.location.href,
  ).toString()
  const rootMeta = await fetchJson<OmezarrRootMetadata>(`${storeUrl}/zarr.json`)
  const multiscale = multiscalesFromRoot(rootMeta)[0]
  const dataset = multiscale?.datasets?.[level]
  if (!dataset) {
    throw new Error(`OME-Zarr level ${level} not found in ${OMEZARR_ID}`)
  }

  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(),
  })
  const store = zarr.withByteCaching(baseStore, {
    cache: new ByteLruCache(ZARR_BYTE_CACHE_BYTES),
  })
  const array = await zarr.open(zarr.root(store).resolve(`/${dataset.path}`), {
    kind: 'array',
  })
  const dtype = assertSupportedDtype(array.dtype)
  const dtypeInfo = niftiDatatype(dtype)
  const [shapeZ, shapeY, shapeX] = trailingSpatial(array.shape, 'shape')
  const [chunkZ, chunkY, chunkX] = trailingSpatial(array.chunks, 'chunks')
  const shape: Shape3 = [shapeX, shapeY, shapeZ]
  const chunkShape: Shape3 = [chunkX, chunkY, chunkZ]
  const chunkGrid: Shape3 = [
    Math.ceil(shape[0] / chunkShape[0]),
    Math.ceil(shape[1] / chunkShape[1]),
    Math.ceil(shape[2] / chunkShape[2]),
  ]

  return {
    kind: 'omezarr',
    id: `${OMEZARR_ID}:level-${level}`,
    name: `${OMEZARR_NAME} L${level}`,
    shape,
    spacing: scaleFromDataset(dataset),
    dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: OMEZARR_DEFAULT_WINDOW,
    chunkGrid,
    chunkShape,
    chunkCount: chunkGrid[0] * chunkGrid[1] * chunkGrid[2],
    sourceUrl: `${OMEZARR_ID}/${dataset.path}`,
    transportLabel: 'OME-Zarr chunk objects',
    array,
    level,
    levelPath: dataset.path,
  }
}

async function loadActiveSource(): Promise<LoadedSource> {
  return currentSourceKind() === 'omezarr'
    ? loadOmezarrSource()
    : loadSyntheticSource()
}

function createChunkPlan(source: LoadedSource): ChunkPlan {
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

function estimateStreamingGrid(shape: Shape3): Shape3 {
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

function createRangeChunkSource(source: RangeSource): VolumeChunkSource {
  const cache = new Map<number, Promise<Uint8Array>>()
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

function createOmezarrChunkSource(source: OmezarrSource): VolumeChunkSource {
  const cache = new Map<number, Promise<Uint8Array>>()
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
      .catch((err: unknown) => {
        stats.failures++
        renderHud()
        throw err
      })
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
}

async function fetchOmezarrChunk(
  source: OmezarrSource,
  request: ChunkRequest,
): Promise<Uint8Array> {
  const [x0, y0, z0] = request.desc.texOrigin
  const [sx, sy, sz] = request.desc.texDims
  const selection: Array<number | zarr.Slice> = []
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

function bytesFromZarrView(view: unknown): Uint8Array {
  if (typeof view !== 'object' || view === null || !('data' in view)) {
    throw new Error('OME-Zarr selection returned a scalar instead of a chunk')
  }
  const data = (view as { data: unknown }).data
  if (!ArrayBuffer.isView(data)) {
    throw new Error('OME-Zarr chunk data is not buffer-backed')
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function createStreamingVolume(source: LoadedSource): NVImage {
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

function renderChunkStrip(): void {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const chunkCount = plan?.chunks.length ?? source.chunkCount
  const columns = Math.min(16, Math.max(4, gridDims[0] * gridDims[1]))
  els.chunkStrip.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
  const nodes: HTMLSpanElement[] = []
  for (let i = 0; i < chunkCount; i++) {
    const span = document.createElement('span')
    if (stats.completed.has(i)) span.className = 'hit'
    nodes.push(span)
  }
  els.chunkStrip.replaceChildren(...nodes)
}

function httpSummary(): string {
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

function renderHud(): void {
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

function chunkShapeFromPlan(plan: ChunkPlan): Shape3 {
  return plan.chunks.reduce<Shape3>(
    (max, chunk) => [
      Math.max(max[0], chunk.texDims[0]),
      Math.max(max[1], chunk.texDims[1]),
      Math.max(max[2], chunk.texDims[2]),
    ],
    [0, 0, 0],
  )
}

function startHudPolling(): void {
  if (pollHandle !== 0) cancelAnimationFrame(pollHandle)
  const tick = (): void => {
    renderHud()
    pollHandle = requestAnimationFrame(tick)
  }
  pollHandle = requestAnimationFrame(tick)
}

function applyLayout(): void {
  if (!nv) return
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  renderHud()
}

async function reloadVolume(
  options: { reloadSource?: boolean } = {},
): Promise<void> {
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

async function main(): Promise<void> {
  initControlsFromUrl()
  updateUrlFromControls()

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.MULTIPLANAR,
    maxTextureDimension3D: 256,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)

  els.source.addEventListener('change', () => {
    setDefaultWindowForSelectedSource()
    syncSourceControls()
    updateUrlFromControls()
    void reloadVolume({ reloadSource: true })
  })
  els.level.addEventListener('change', () => {
    setDefaultWindowForSelectedSource()
    updateUrlFromControls()
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

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
