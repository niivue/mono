import { installNav } from './nav'

installNav()

const SYNTHETIC_MANIFEST_URL = assetUrl('tile-range-poc/tiles.json')
const DEFAULT_DICOM_WSI_ID = 'cptac-brca_dicom'
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const TARGET_SCREEN_PIXELS_PER_TILE_PIXEL = 0.75
const RANGE_LOG_LENGTH = 24

type TileSourceKind = 'synthetic' | 'dicom-wsi'
type TileCodec = 'raw-rgba' | 'image/jpeg'

interface TileFragment {
  offset: number
  length: number
}

interface TileManifestEntry {
  x: number
  y: number
  width: number
  height: number
  frame?: number
  offset?: number
  length?: number
  fragments?: TileFragment[]
}

interface TileLevelManifest {
  index: number
  width: number
  height: number
  downsample: number
  tileWidth?: number
  tileHeight?: number
  columns: number
  rows: number
  fileUrl?: string
  codec?: TileCodec
  tiles: TileManifestEntry[]
}

interface TileRangeManifest {
  id: string
  name: string
  format?: 'dicom-wsi-range-v1'
  width: number
  height: number
  displayYAxis?: 'down' | 'up'
  tileSize?: number
  dtype: 'uint8'
  channels: 'rgba' | 'encoded-rgb'
  bytesPerPixel?: 4
  byteLength?: number
  dataUrl?: string
  order?: string
  levels: TileLevelManifest[]
}

interface Viewport {
  centerX: number
  centerY: number
  scale: number
}

interface TileBitmap {
  bitmap: ImageBitmap
  bytes: number
}

interface TileStats {
  requested: number
  completed: number
  rangeHits: number
  fullFileFallbacks: number
  failures: number
  wireBytes: number
  decodedBytes: number
  cacheHits: number
  cacheBytes: number
  lastRequests: RangeEvent[]
}

interface RangeEvent {
  label: string
  status: 'pending' | 'hit' | 'fallback' | 'failed'
}

interface VisibleTile {
  tile: TileManifestEntry
  key: string
  screenX: number
  screenY: number
  screenWidth: number
  screenHeight: number
}

class TileCache {
  private readonly entries = new Map<string, TileBitmap>()
  bytes = 0

  constructor(private readonly maxBytes: number) {}

  get(key: string): TileBitmap | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    stats.cacheHits++
    return entry
  }

  set(key: string, entry: TileBitmap): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.bitmap.close()
      this.bytes -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    this.evict()
    stats.cacheBytes = this.bytes
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey !== 'string') return
      const entry = this.entries.get(firstKey)
      if (!entry) return
      entry.bitmap.close()
      this.entries.delete(firstKey)
      this.bytes -= entry.bytes
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
  levelMode: el<HTMLSelectElement>('levelMode'),
  zoomOut: el<HTMLButtonElement>('zoomOut'),
  zoomIn: el<HTMLButtonElement>('zoomIn'),
  fit: el<HTMLButtonElement>('fit'),
  showGrid: el<HTMLInputElement>('showGrid'),
  canvas: el<HTMLCanvasElement>('tileCanvas'),
  hud: el<HTMLDivElement>('hud'),
  rangeLog: el<HTMLDivElement>('rangeLog'),
  fallback: el<HTMLDivElement>('fallback'),
}

const ctx = createCanvasContext()

let manifest: TileRangeManifest | null = null
let manifestUrl = ''
let dataUrl = ''
let viewport: Viewport = { centerX: 0, centerY: 0, scale: 1 }
let cache = new TileCache(MAX_CACHE_BYTES)
let pending = new Set<string>()
let stats = freshStats()
let animationFrame = 0
let hasFit = false
let drag: {
  pointerId: number
  lastX: number
  lastY: number
} | null = null

function createCanvasContext(): CanvasRenderingContext2D {
  const context = els.canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('2D canvas is not available')
  return context
}

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${path.replace(/^\//, '')}`
}

function relativeUrl(baseUrl: string, relative: string): string {
  return new URL(relative, new URL(baseUrl, window.location.href)).toString()
}

function sourceFromUrl(): TileSourceKind {
  const params = new URLSearchParams(window.location.search)
  return params.get('source') === 'dicom-wsi' ? 'dicom-wsi' : 'synthetic'
}

function currentSourceKind(): TileSourceKind {
  return els.source.value === 'dicom-wsi' ? 'dicom-wsi' : 'synthetic'
}

function manifestUrlForSource(source: TileSourceKind): string {
  if (source === 'dicom-wsi') {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id') || DEFAULT_DICOM_WSI_ID
    return `/dicom-wsi/${encodeURIComponent(id)}/manifest.json`
  }
  return SYNTHETIC_MANIFEST_URL
}

function syncSourceUrl(source: TileSourceKind): void {
  const url = new URL(window.location.href)
  if (source === 'dicom-wsi') {
    url.searchParams.set('source', source)
    if (!url.searchParams.has('id')) {
      url.searchParams.set('id', DEFAULT_DICOM_WSI_ID)
    }
  } else {
    url.searchParams.delete('source')
    url.searchParams.delete('id')
  }
  window.history.replaceState(null, '', url)
}

function freshStats(): TileStats {
  return {
    requested: 0,
    completed: 0,
    rangeHits: 0,
    fullFileFallbacks: 0,
    failures: 0,
    wireBytes: 0,
    decodedBytes: 0,
    cacheHits: 0,
    cacheBytes: 0,
    lastRequests: [],
  }
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function resizeCanvas(): void {
  const rect = els.canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(rect.width * dpr))
  const height = Math.max(1, Math.floor(rect.height * dpr))
  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width
    els.canvas.height = height
  }
}

function cssWidth(): number {
  return els.canvas.width / (window.devicePixelRatio || 1)
}

function cssHeight(): number {
  return els.canvas.height / (window.devicePixelRatio || 1)
}

function isYAxisUp(): boolean {
  return manifest?.displayYAxis === 'up'
}

function fitScaleFor(manifest: TileRangeManifest): number {
  return (
    Math.min(cssWidth() / manifest.width, cssHeight() / manifest.height) * 0.94
  )
}

function fitView(): void {
  const currentManifest = manifest
  if (!currentManifest) return
  resizeCanvas()
  viewport = {
    centerX: currentManifest.width / 2,
    centerY: currentManifest.height / 2,
    scale: fitScaleFor(currentManifest),
  }
  hasFit = true
  requestRender()
}

function clampViewport(): void {
  const currentManifest = manifest
  if (!currentManifest) return
  const minScale = fitScaleFor(currentManifest) * 0.35
  const maxScale = 16
  viewport.scale = clamp(viewport.scale, minScale, maxScale)
  const halfWidth = cssWidth() / (2 * viewport.scale)
  const halfHeight = cssHeight() / (2 * viewport.scale)
  const padX = Math.max(currentManifest.width * 0.08, halfWidth * 0.25)
  const padY = Math.max(currentManifest.height * 0.08, halfHeight * 0.25)
  viewport.centerX = clamp(
    viewport.centerX,
    -padX + halfWidth,
    currentManifest.width + padX - halfWidth,
  )
  viewport.centerY = clamp(
    viewport.centerY,
    -padY + halfHeight,
    currentManifest.height + padY - halfHeight,
  )
}

function screenToBase(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = els.canvas.getBoundingClientRect()
  const left = viewport.centerX - cssWidth() / (2 * viewport.scale)
  const top = viewport.centerY - cssHeight() / (2 * viewport.scale)
  const y = isYAxisUp()
    ? viewport.centerY - (clientY - rect.top - cssHeight() / 2) / viewport.scale
    : top + (clientY - rect.top) / viewport.scale
  return {
    x: left + (clientX - rect.left) / viewport.scale,
    y,
  }
}

function zoomBy(factor: number, clientX?: number, clientY?: number): void {
  const before =
    typeof clientX === 'number' && typeof clientY === 'number'
      ? screenToBase(clientX, clientY)
      : { x: viewport.centerX, y: viewport.centerY }
  const rect = els.canvas.getBoundingClientRect()
  const anchorX =
    typeof clientX === 'number' ? clientX - rect.left : cssWidth() / 2
  const anchorY =
    typeof clientY === 'number' ? clientY - rect.top : cssHeight() / 2
  viewport.scale *= factor
  clampViewport()
  const left = before.x - anchorX / viewport.scale
  const top = before.y - anchorY / viewport.scale
  viewport.centerX = left + cssWidth() / (2 * viewport.scale)
  viewport.centerY = isYAxisUp()
    ? before.y + (anchorY - cssHeight() / 2) / viewport.scale
    : top + cssHeight() / (2 * viewport.scale)
  clampViewport()
  requestRender()
}

function selectedLevel(): TileLevelManifest | null {
  const currentManifest = manifest
  if (!currentManifest) return null
  const mode = els.levelMode.value
  if (mode !== 'auto') {
    const index = Number(mode)
    return currentManifest.levels.find((level) => level.index === index) ?? null
  }
  for (const level of currentManifest.levels) {
    if (
      viewport.scale * level.downsample >=
      TARGET_SCREEN_PIXELS_PER_TILE_PIXEL
    ) {
      return level
    }
  }
  return currentManifest.levels[currentManifest.levels.length - 1] ?? null
}

function tileKey(level: TileLevelManifest, tile: TileManifestEntry): string {
  return `L${level.index}/${tile.x}/${tile.y}`
}

function levelTileWidth(level: TileLevelManifest): number {
  return level.tileWidth ?? manifest?.tileSize ?? 1
}

function levelTileHeight(level: TileLevelManifest): number {
  return level.tileHeight ?? manifest?.tileSize ?? 1
}

function pushRangeEvent(event: RangeEvent): void {
  stats.lastRequests.push(event)
  while (stats.lastRequests.length > RANGE_LOG_LENGTH) {
    stats.lastRequests.shift()
  }
}

function updateRangeEvent(label: string, status: RangeEvent['status']): void {
  const existing = stats.lastRequests.findLast((event) => event.label === label)
  if (existing) {
    existing.status = status
  } else {
    pushRangeEvent({ label, status })
  }
}

function tileAt(
  level: TileLevelManifest,
  x: number,
  y: number,
): TileManifestEntry | null {
  if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) return null
  return level.tiles[y * level.columns + x] ?? null
}

function visibleTiles(level: TileLevelManifest): VisibleTile[] {
  const viewLeft = viewport.centerX - cssWidth() / (2 * viewport.scale)
  const viewTop = viewport.centerY - cssHeight() / (2 * viewport.scale)
  const viewRight = viewport.centerX + cssWidth() / (2 * viewport.scale)
  const viewBottom = viewport.centerY + cssHeight() / (2 * viewport.scale)
  const levelLeft = Math.floor(viewLeft / level.downsample)
  const levelTop = Math.floor(viewTop / level.downsample)
  const levelRight = Math.ceil(viewRight / level.downsample)
  const levelBottom = Math.ceil(viewBottom / level.downsample)
  const tileWidth = levelTileWidth(level)
  const tileHeight = levelTileHeight(level)
  const firstX = clamp(Math.floor(levelLeft / tileWidth), 0, level.columns - 1)
  const firstY = clamp(Math.floor(levelTop / tileHeight), 0, level.rows - 1)
  const lastX = clamp(
    Math.floor((levelRight - 1) / tileWidth),
    0,
    level.columns - 1,
  )
  const lastY = clamp(
    Math.floor((levelBottom - 1) / tileHeight),
    0,
    level.rows - 1,
  )
  const dpr = window.devicePixelRatio || 1
  const screenScale = viewport.scale * dpr
  const tiles: VisibleTile[] = []

  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const tile = tileAt(level, x, y)
      if (!tile) continue
      const baseX = tile.x * tileWidth * level.downsample
      const baseY = tile.y * tileHeight * level.downsample
      const baseWidth = tile.width * level.downsample
      const baseHeight = tile.height * level.downsample
      const screenY = isYAxisUp()
        ? (viewBottom - (baseY + baseHeight)) * screenScale
        : (baseY - viewTop) * screenScale
      tiles.push({
        tile,
        key: tileKey(level, tile),
        screenX: (baseX - viewLeft) * screenScale,
        screenY,
        screenWidth: baseWidth * screenScale,
        screenHeight: baseHeight * screenScale,
      })
    }
  }
  return tiles
}

function tileSourceUrl(level: TileLevelManifest): string {
  if (level.fileUrl) return relativeUrl(manifestUrl, level.fileUrl)
  if (dataUrl) return dataUrl
  throw new Error(`No byte source for L${level.index}`)
}

function tileFragments(tile: TileManifestEntry): TileFragment[] {
  if (typeof tile.offset === 'number' && typeof tile.length === 'number') {
    return [{ offset: tile.offset, length: tile.length }]
  }
  if (tile.fragments && tile.fragments.length > 0) return tile.fragments
  throw new Error(`Tile ${tile.x}/${tile.y} has no byte ranges`)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(length)
  let ptr = 0
  for (const part of parts) {
    out.set(part, ptr)
    ptr += part.byteLength
  }
  return out
}

function copyUint8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function copyClamped(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const copy = new Uint8ClampedArray(bytes.byteLength)
  copy.set(bytes)
  return copy
}

async function fetchTileFragment(
  sourceUrl: string,
  fragment: TileFragment,
  label: string,
): Promise<Uint8Array> {
  const start = fragment.offset
  const end = fragment.offset + fragment.length - 1
  const rangeLabel = `${label} ${start}-${end}`
  pushRangeEvent({ label: rangeLabel, status: 'pending' })
  const response = await fetch(sourceUrl, {
    headers: {
      Range: `bytes=${start}-${end}`,
    },
  })
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`)
  }
  const wireBytes = new Uint8Array(await response.arrayBuffer())
  stats.wireBytes += wireBytes.byteLength
  if (response.status === 206) {
    stats.rangeHits++
    updateRangeEvent(rangeLabel, 'hit')
    if (wireBytes.byteLength !== fragment.length) {
      throw new Error(
        `Expected ${fragment.length} bytes, received ${wireBytes.byteLength}`,
      )
    }
    return wireBytes
  }
  stats.fullFileFallbacks++
  updateRangeEvent(rangeLabel, 'fallback')
  return wireBytes.slice(start, end + 1)
}

async function fetchTileBytes(
  sourceUrl: string,
  tile: TileManifestEntry,
  label: string,
): Promise<Uint8Array> {
  const fragments = tileFragments(tile)
  const parts = await Promise.all(
    fragments.map((fragment) => fetchTileFragment(sourceUrl, fragment, label)),
  )
  return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts)
}

async function decodeTileBitmap(
  level: TileLevelManifest,
  tile: TileManifestEntry,
  tileBytes: Uint8Array,
): Promise<ImageBitmap> {
  const codec = level.codec ?? 'raw-rgba'
  if (codec === 'image/jpeg') {
    const blob = new Blob([copyUint8(tileBytes)], { type: 'image/jpeg' })
    return createImageBitmap(blob)
  }
  const expected = tile.width * tile.height * 4
  if (tileBytes.byteLength !== expected) {
    throw new Error(
      `Expected ${expected} RGBA bytes, received ${tileBytes.byteLength}`,
    )
  }
  const clamped = copyClamped(tileBytes)
  return createImageBitmap(new ImageData(clamped, tile.width, tile.height))
}

async function loadTile(
  level: TileLevelManifest,
  tile: TileManifestEntry,
): Promise<void> {
  const key = tileKey(level, tile)
  if (cache.has(key) || pending.has(key)) return
  pending.add(key)
  stats.requested++
  const label = `${key}${typeof tile.frame === 'number' ? ` f${tile.frame}` : ''}`
  requestRender()

  try {
    const tileBytes = await fetchTileBytes(tileSourceUrl(level), tile, label)
    stats.decodedBytes += tileBytes.byteLength
    const bitmap = await decodeTileBitmap(level, tile, tileBytes)
    cache.set(key, { bitmap, bytes: tileBytes.byteLength })
    stats.completed++
  } catch (err) {
    stats.failures++
    updateRangeEvent(label, 'failed')
    console.error(`Failed to load tile ${key}`, err)
  } finally {
    pending.delete(key)
    requestRender()
  }
}

function drawPlaceholder(tile: VisibleTile): void {
  ctx.fillStyle = '#111917'
  ctx.fillRect(tile.screenX, tile.screenY, tile.screenWidth, tile.screenHeight)
  ctx.strokeStyle = 'rgba(228, 180, 95, 0.38)'
  ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1)
  ctx.strokeRect(
    tile.screenX + 0.5,
    tile.screenY + 0.5,
    Math.max(0, tile.screenWidth - 1),
    Math.max(0, tile.screenHeight - 1),
  )
}

function drawGrid(tile: VisibleTile): void {
  ctx.strokeStyle = 'rgba(116, 212, 207, 0.24)'
  ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1)
  ctx.strokeRect(
    tile.screenX + 0.5,
    tile.screenY + 0.5,
    Math.max(0, tile.screenWidth - 1),
    Math.max(0, tile.screenHeight - 1),
  )
}

function drawWorldBackground(): void {
  ctx.fillStyle = '#020303'
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height)
  const currentManifest = manifest
  if (!currentManifest) return
  const dpr = window.devicePixelRatio || 1
  const viewLeft = viewport.centerX - cssWidth() / (2 * viewport.scale)
  const viewTop = viewport.centerY - cssHeight() / (2 * viewport.scale)
  const viewBottom = viewport.centerY + cssHeight() / (2 * viewport.scale)
  const x = -viewLeft * viewport.scale * dpr
  const y = isYAxisUp()
    ? (viewBottom - currentManifest.height) * viewport.scale * dpr
    : -viewTop * viewport.scale * dpr
  const width = currentManifest.width * viewport.scale * dpr
  const height = currentManifest.height * viewport.scale * dpr
  ctx.fillStyle = '#07100d'
  ctx.fillRect(x, y, width, height)
  ctx.strokeStyle = 'rgba(152, 167, 160, 0.34)'
  ctx.lineWidth = Math.max(1, dpr)
  ctx.strokeRect(
    x + 0.5,
    y + 0.5,
    Math.max(0, width - 1),
    Math.max(0, height - 1),
  )
}

function drawTileBitmap(visible: VisibleTile, bitmap: ImageBitmap): void {
  if (!isYAxisUp()) {
    ctx.drawImage(
      bitmap,
      visible.screenX,
      visible.screenY,
      visible.screenWidth,
      visible.screenHeight,
    )
    return
  }
  ctx.save()
  ctx.translate(visible.screenX, visible.screenY + visible.screenHeight)
  ctx.scale(1, -1)
  ctx.drawImage(bitmap, 0, 0, visible.screenWidth, visible.screenHeight)
  ctx.restore()
}

function updateHud(
  level: TileLevelManifest | null,
  tiles: VisibleTile[],
): void {
  const currentManifest = manifest
  if (!currentManifest || !level) {
    els.hud.innerHTML = '<div class="title">Loading tile manifest</div>'
    return
  }
  const mode = els.levelMode.value === 'auto' ? 'auto' : 'fixed'
  const zoom =
    viewport.scale >= 1
      ? `${viewport.scale.toFixed(2)}x`
      : `1:${(1 / viewport.scale).toFixed(1)}`
  const pendingCount = pending.size
  const sourceLabel = level.fileUrl ?? currentManifest.dataUrl ?? manifestUrl
  const codec = level.codec ?? 'raw-rgba'
  els.hud.innerHTML = `
    <div class="title">${html(currentManifest.name)}</div>
    <div class="row"><span class="key">source</span><span>${html(sourceLabel)}</span></div>
    <div class="row"><span class="key">codec</span><span>${html(codec)}</span></div>
    <div class="row"><span class="key">level</span><span>L${level.index} ${mode} ${level.width}x${level.height}</span></div>
    <div class="row"><span class="key">zoom</span><span>${zoom}</span></div>
    <div class="row"><span class="key">tiles</span><span>${tiles.length} visible, ${pendingCount} pending</span></div>
    <div class="row"><span class="key">requests</span><span>${stats.completed}/${stats.requested} done</span></div>
    <div class="row"><span class="key">range</span><span class="ok">${stats.rangeHits} HTTP 206</span></div>
    <div class="row"><span class="key">fallback</span><span class="${stats.fullFileFallbacks > 0 ? 'warn' : ''}">${stats.fullFileFallbacks} HTTP 200</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(stats.wireBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${formatBytes(stats.cacheBytes)} / ${stats.cacheHits} hits</span></div>
    <div class="row"><span class="key">failures</span><span class="${stats.failures > 0 ? 'bad' : ''}">${stats.failures}</span></div>
  `
}

function updateRangeLog(): void {
  const emptySlots = RANGE_LOG_LENGTH - stats.lastRequests.length
  const spans: HTMLSpanElement[] = []
  for (let i = 0; i < emptySlots; i++) {
    spans.push(document.createElement('span'))
  }
  for (const event of stats.lastRequests) {
    const span = document.createElement('span')
    span.className = event.status === 'hit' ? 'hit' : event.status
    span.title = event.label
    spans.push(span)
  }
  els.rangeLog.replaceChildren(...spans)
}

function render(): void {
  resizeCanvas()
  if (manifest && !hasFit) fitView()
  clampViewport()
  drawWorldBackground()
  const level = selectedLevel()
  const tiles = level ? visibleTiles(level) : []
  for (const visible of tiles) {
    const cached = cache.get(visible.key)
    if (cached) {
      drawTileBitmap(visible, cached.bitmap)
    } else {
      drawPlaceholder(visible)
      if (level) void loadTile(level, visible.tile)
    }
    if (els.showGrid.checked) drawGrid(visible)
  }
  updateHud(level, tiles)
  updateRangeLog()
}

function requestRender(): void {
  if (animationFrame !== 0) return
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0
    render()
  })
}

function populateLevels(currentManifest: TileRangeManifest): void {
  els.levelMode.replaceChildren()
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = 'auto lod'
  els.levelMode.appendChild(auto)
  for (const level of currentManifest.levels) {
    const option = document.createElement('option')
    option.value = String(level.index)
    option.textContent = `L${level.index} ${level.width}x${level.height}`
    els.levelMode.appendChild(option)
  }
  els.levelMode.value = 'auto'
}

function resetTileState(): void {
  cache = new TileCache(MAX_CACHE_BYTES)
  pending = new Set<string>()
  stats = freshStats()
}

function showFallback(message: string): void {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback(): void {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

async function loadManifestForCurrentSource(): Promise<void> {
  hideFallback()
  manifest = null
  hasFit = false
  resetTileState()
  requestRender()
  const source = currentSourceKind()
  syncSourceUrl(source)
  manifestUrl = manifestUrlForSource(source)
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`)
  const loaded = (await response.json()) as TileRangeManifest
  manifest = loaded
  dataUrl = loaded.dataUrl ? relativeUrl(manifestUrl, loaded.dataUrl) : ''
  populateLevels(loaded)
  hasFit = false
  fitView()
}

els.canvas.addEventListener('pointerdown', (event) => {
  els.canvas.setPointerCapture(event.pointerId)
  drag = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
})

els.canvas.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return
  const dx = event.clientX - drag.lastX
  const dy = event.clientY - drag.lastY
  drag.lastX = event.clientX
  drag.lastY = event.clientY
  viewport.centerX -= dx / viewport.scale
  viewport.centerY += (isYAxisUp() ? 1 : -1) * (dy / viewport.scale)
  clampViewport()
  requestRender()
})

els.canvas.addEventListener('pointerup', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener('pointercancel', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    zoomBy(Math.exp(-event.deltaY * 0.0013), event.clientX, event.clientY)
  },
  { passive: false },
)

els.levelMode.addEventListener('change', requestRender)
els.source.addEventListener('change', () => {
  void loadManifestForCurrentSource().catch((err: unknown) => {
    console.error(err)
    showFallback(err instanceof Error ? err.message : String(err))
  })
})
els.showGrid.addEventListener('change', requestRender)
els.fit.addEventListener('click', fitView)
els.zoomIn.addEventListener('click', () => zoomBy(1.45))
els.zoomOut.addEventListener('click', () => zoomBy(1 / 1.45))
window.addEventListener('resize', requestRender)

els.source.value = sourceFromUrl()

loadManifestForCurrentSource()
  .then(requestRender)
  .catch((err: unknown) => {
    console.error(err)
    showFallback(err instanceof Error ? err.message : String(err))
  })
