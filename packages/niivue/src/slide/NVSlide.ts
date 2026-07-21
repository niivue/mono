export type NVSlideTileCodec = 'raw-rgba' | 'image/jpeg' | 'image/jp2'

/**
 * Decodes one tile's encoded bytes into an ImageBitmap. The built-in registry
 * handles `raw-rgba` and `image/jpeg`; `image/jp2` (JPEG 2000) has no browser
 * decoder, so a consumer must register one (e.g. an OpenJPEG WASM build) via
 * {@link NVSlide.registerTileDecoder} — keeping the heavy codec out of the core.
 */
export type SlideTileDecoder = (
  bytes: Uint8Array,
  ctx: { width: number; height: number },
) => Promise<ImageBitmap>
export type NVSlideYAxis = 'down' | 'up'
export type NVSlideLevelChoice = 'auto' | number
export type NVSlideColor = [number, number, number, number]

export interface NVSlideTileFragment {
  offset: number
  length: number
}

export interface NVSlideTileManifest {
  x: number
  y: number
  width: number
  height: number
  frame?: number
  offset?: number
  length?: number
  fragments?: NVSlideTileFragment[]
}

export interface NVSlideLevelManifest {
  index: number
  width: number
  height: number
  downsample: number
  tileWidth?: number
  tileHeight?: number
  columns: number
  rows: number
  fileUrl?: string
  codec?: NVSlideTileCodec
  tiles: NVSlideTileManifest[]
}

export interface NVSlideManifest {
  id: string
  name: string
  format?: string
  width: number
  height: number
  displayYAxis?: NVSlideYAxis
  tileSize?: number
  dtype: string
  channels: string
  bytesPerPixel?: number
  byteLength?: number
  dataUrl?: string
  order?: string
  levels: NVSlideLevelManifest[]
  /**
   * Physical size of one base (level-0) pixel in millimetres, as [x, y] (column,
   * row). For DICOM-WSI this comes from PixelSpacing (0028,0030). Undefined when
   * the source carries no physical scale; a measurement UI then falls back to
   * pixels. `screenToSlide` returns base-pixel coordinates, so distance in mm =
   * base-pixel distance x this spacing.
   */
  pixelSpacingMM?: readonly [number, number]
}

export interface NVSlideViewport {
  centerX: number
  centerY: number
  scale: number
}

export interface NVSlideSpatialTransform {
  /**
   * Column-major 4x4 transform from slide pixel coordinates into the base
   * image/world space. The initial renderer uses standalone slide viewports;
   * this is the registration hook for mapped slides.
   */
  pixelToWorld?: readonly number[]
  /**
   * Optional inverse of pixelToWorld. Callers can provide it to avoid repeated
   * inversion when registering a slide against a base volume.
   */
  worldToPixel?: readonly number[]
}

export interface NVSlideOptions {
  id?: string
  name?: string
  manifestUrl?: string
  opacity?: number
  visible?: boolean
  viewport?: NVSlideViewport
  levelChoice?: NVSlideLevelChoice
  maxCacheBytes?: number
  maxScale?: number
  targetScreenPixelsPerTilePixel?: number
  showTileGrid?: boolean
  backgroundColor?: NVSlideColor
  placeholderColor?: NVSlideColor
  gridColor?: NVSlideColor
  spatialTransform?: NVSlideSpatialTransform
  /** Pluggable tile source. Defaults to a byte-range manifest source; DZI / TIFF
   * adapters supply their own. See {@link SlideTileSource}. */
  source?: SlideTileSource
}

export interface NVSlideScreen {
  widthCss: number
  heightCss: number
  devicePixelRatio?: number
}

export interface NVSlideVisibleTile {
  slide: NVSlide
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  key: string
  screenX: number
  screenY: number
  screenWidth: number
  screenHeight: number
  flipY: boolean
}

export interface NVSlideVisibleTiles {
  level: NVSlideLevelManifest | null
  tiles: NVSlideVisibleTile[]
}

export interface NVSlideScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export type NVSlideRangeStatus = 'pending' | 'hit' | 'fallback' | 'failed'

export interface NVSlideRangeEvent {
  label: string
  status: NVSlideRangeStatus
}

export interface NVSlideStats {
  requested: number
  completed: number
  rangeHits: number
  fullFileFallbacks: number
  failures: number
  wireBytes: number
  decodedBytes: number
  cacheHits: number
  cacheBytes: number
  lastRequests: NVSlideRangeEvent[]
}

type TileBitmap = {
  bitmap: ImageBitmap
  bytes: number
}

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024
const DEFAULT_TARGET_SCREEN_PIXELS_PER_TILE_PIXEL = 0.75
const DEFAULT_RANGE_LOG_LENGTH = 24

function freshStats(): NVSlideStats {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
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

// Tile-codec registry. Built-ins cover the browser-native paths; additional
// codecs (e.g. image/jp2 via an OpenJPEG WASM decoder) are registered by the
// consumer with NVSlide.registerTileDecoder, so the core ships no heavy codec.
const tileDecoders = new Map<string, SlideTileDecoder>([
  [
    'image/jpeg',
    (bytes) =>
      createImageBitmap(new Blob([copyUint8(bytes)], { type: 'image/jpeg' })),
  ],
  [
    'raw-rgba',
    (bytes, { width, height }) => {
      const expected = width * height * 4
      if (bytes.byteLength !== expected) {
        throw new Error(
          `Expected ${expected} RGBA bytes, received ${bytes.byteLength}`,
        )
      }
      return createImageBitmap(new ImageData(copyClamped(bytes), width, height))
    },
  ],
])

class NVSlideTileCache {
  private readonly entries = new Map<string, TileBitmap>()
  bytes = 0

  constructor(private readonly maxBytes: number) {}

  get(key: string): TileBitmap | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
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
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.bitmap.close()
    }
    this.entries.clear()
    this.bytes = 0
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

/**
 * Telemetry + URL hooks a {@link SlideTileSource} uses. NVSlide implements this
 * so a source can resolve relative URLs and record wire bytes / range-request
 * status into the slide's stats + recent-request log without owning them.
 */
export interface SlideSourceHost {
  resolveUrl(url: string): string
  addWireBytes(bytes: number): void
  rangeHit(): void
  rangeFallback(): void
  pushRangeEvent(event: NVSlideRangeEvent): void
  updateRangeEvent(label: string, status: NVSlideRangeStatus): void
}

/**
 * A pluggable slide source: owns the pyramid manifest and fetches the ENCODED
 * bytes for one tile. NVSlide owns decoding (per `level.codec`), caching, stats
 * and the viewport; a source varies by FORMAT. {@link ManifestRangeSource} (the
 * default) addresses tiles as byte ranges in a per-level file (dicom-wsi-range-v1
 * and the synthetic pyramid); DZI (per-tile URLs) and TIFF (IFD tile offsets) are
 * future sources implementing this same contract.
 */
export interface SlideTileSource {
  readonly manifest: NVSlideManifest
  /** Adopted by an NVSlide before any fetch; wires up telemetry + URL resolution. */
  bind(host: SlideSourceHost): void
  /** Fetch the encoded bytes for one tile (NVSlide decodes per level.codec). */
  fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
  ): Promise<Uint8Array>
}

/**
 * Default source: a byte-range manifest (dicom-wsi-range-v1 / synthetic pyramid).
 * Each tile is one or more byte fragments addressed into a per-level file (or the
 * manifest `dataUrl`), fetched with an HTTP Range request (206) and a full-file
 * fallback for servers without range support.
 */
export class ManifestRangeSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null

  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  private requireHost(): SlideSourceHost {
    if (!this.host) {
      throw new Error('ManifestRangeSource is not bound to an NVSlide host')
    }
    return this.host
  }

  private tileSourceUrl(level: NVSlideLevelManifest): string {
    const host = this.requireHost()
    if (level.fileUrl) return host.resolveUrl(level.fileUrl)
    if (this.manifest.dataUrl) return host.resolveUrl(this.manifest.dataUrl)
    throw new Error(`No byte source for slide L${level.index}`)
  }

  private tileFragments(tile: NVSlideTileManifest): NVSlideTileFragment[] {
    if (typeof tile.offset === 'number' && typeof tile.length === 'number') {
      return [{ offset: tile.offset, length: tile.length }]
    }
    if (tile.fragments && tile.fragments.length > 0) return tile.fragments
    throw new Error(`Tile ${tile.x}/${tile.y} has no byte ranges`)
  }

  private async fetchFragment(
    sourceUrl: string,
    fragment: NVSlideTileFragment,
    label: string,
  ): Promise<Uint8Array> {
    const host = this.requireHost()
    const start = fragment.offset
    const end = fragment.offset + fragment.length - 1
    const rangeLabel = `${label} ${start}-${end}`
    host.pushRangeEvent({ label: rangeLabel, status: 'pending' })
    const response = await fetch(sourceUrl, {
      headers: { Range: `bytes=${start}-${end}` },
    })
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`)
    }
    const wireBytes = new Uint8Array(await response.arrayBuffer())
    host.addWireBytes(wireBytes.byteLength)
    if (response.status === 206) {
      host.rangeHit()
      host.updateRangeEvent(rangeLabel, 'hit')
      if (wireBytes.byteLength !== fragment.length) {
        throw new Error(
          `Expected ${fragment.length} bytes, received ${wireBytes.byteLength}`,
        )
      }
      return wireBytes
    }
    host.rangeFallback()
    host.updateRangeEvent(rangeLabel, 'fallback')
    return wireBytes.slice(start, end + 1)
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
  ): Promise<Uint8Array> {
    const sourceUrl = this.tileSourceUrl(level)
    const fragments = this.tileFragments(tile)
    const parts = await Promise.all(
      fragments.map((fragment) =>
        this.fetchFragment(sourceUrl, fragment, label),
      ),
    )
    return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts)
  }
}

export class NVSlide extends EventTarget {
  readonly id: string
  readonly name: string
  readonly manifest: NVSlideManifest
  readonly manifestUrl: string
  readonly stats: NVSlideStats
  opacity: number
  visible: boolean
  viewport: NVSlideViewport
  levelChoice: NVSlideLevelChoice
  maxScale: number
  targetScreenPixelsPerTilePixel: number
  showTileGrid: boolean
  backgroundColor: NVSlideColor
  placeholderColor: NVSlideColor
  gridColor: NVSlideColor
  spatialTransform: NVSlideSpatialTransform | null
  private readonly _rangeLogLength = DEFAULT_RANGE_LOG_LENGTH
  private readonly _cache: NVSlideTileCache
  private readonly _pending = new Set<string>()
  private readonly _source: SlideTileSource

  constructor(manifest: NVSlideManifest, options: NVSlideOptions = {}) {
    super()
    this.manifest = manifest
    this.manifestUrl = options.manifestUrl ?? ''
    this.id = options.id ?? manifest.id
    this.name = options.name ?? manifest.name
    this.opacity = options.opacity ?? 1
    this.visible = options.visible ?? true
    this.viewport = options.viewport ?? {
      centerX: manifest.width / 2,
      centerY: manifest.height / 2,
      scale: 1,
    }
    this.levelChoice = options.levelChoice ?? 'auto'
    this.maxScale = options.maxScale ?? 16
    this.targetScreenPixelsPerTilePixel =
      options.targetScreenPixelsPerTilePixel ??
      DEFAULT_TARGET_SCREEN_PIXELS_PER_TILE_PIXEL
    this.showTileGrid = options.showTileGrid ?? false
    this.backgroundColor = options.backgroundColor ?? [0.027, 0.063, 0.051, 1]
    this.placeholderColor = options.placeholderColor ?? [0.067, 0.098, 0.09, 1]
    this.gridColor = options.gridColor ?? [0.455, 0.831, 0.812, 0.24]
    this.spatialTransform = options.spatialTransform ?? null
    this.stats = freshStats()
    this._cache = new NVSlideTileCache(
      options.maxCacheBytes ?? DEFAULT_CACHE_BYTES,
    )
    this._source = options.source ?? new ManifestRangeSource(manifest)
    this._source.bind({
      resolveUrl: (url) => this.resolveUrl(url),
      addWireBytes: (n) => {
        this.stats.wireBytes += n
      },
      rangeHit: () => {
        this.stats.rangeHits++
      },
      rangeFallback: () => {
        this.stats.fullFileFallbacks++
      },
      pushRangeEvent: (event) => this.pushRangeEvent(event),
      updateRangeEvent: (label, status) => this.updateRangeEvent(label, status),
    })
  }

  /** Build a slide from any tile source (DICOM-WSI/DZI/TIFF adapter). */
  static fromSource(
    source: SlideTileSource,
    options: NVSlideOptions = {},
  ): NVSlide {
    return new NVSlide(source.manifest, { ...options, source })
  }

  static async fromManifestUrl(
    manifestUrl: string,
    options: NVSlideOptions = {},
  ): Promise<NVSlide> {
    const response = await fetch(manifestUrl)
    if (!response.ok) {
      throw new Error(`Slide manifest HTTP ${response.status}`)
    }
    const manifest = (await response.json()) as NVSlideManifest
    return new NVSlide(manifest, { ...options, manifestUrl })
  }

  get pendingCount(): number {
    return this._pending.size
  }

  get cacheBytes(): number {
    return this._cache.bytes
  }

  setViewport(viewport: NVSlideViewport): void {
    this.viewport = { ...viewport }
    this._emitChange()
  }

  setLevelChoice(levelChoice: NVSlideLevelChoice): void {
    this.levelChoice = levelChoice
    this._emitChange()
  }

  setSpatialTransform(transform: NVSlideSpatialTransform | null): void {
    this.spatialTransform = transform
    this._emitChange()
  }

  setTileGridVisible(visible: boolean): void {
    this.showTileGrid = visible
    this._emitChange()
  }

  isYAxisUp(): boolean {
    return this.manifest.displayYAxis === 'up'
  }

  fitScaleFor(screen: NVSlideScreen, padding = 0.94): number {
    return (
      Math.min(
        screen.widthCss / this.manifest.width,
        screen.heightCss / this.manifest.height,
      ) * padding
    )
  }

  fitToScreen(screen: NVSlideScreen, padding = 0.94): void {
    this.viewport = {
      centerX: this.manifest.width / 2,
      centerY: this.manifest.height / 2,
      scale: this.fitScaleFor(screen, padding),
    }
    this._emitChange()
  }

  clampViewport(screen: NVSlideScreen): void {
    const minScale = this.fitScaleFor(screen) * 0.35
    this.viewport.scale = clamp(this.viewport.scale, minScale, this.maxScale)
    const halfWidth = screen.widthCss / (2 * this.viewport.scale)
    const halfHeight = screen.heightCss / (2 * this.viewport.scale)
    const padX = Math.max(this.manifest.width * 0.08, halfWidth * 0.25)
    const padY = Math.max(this.manifest.height * 0.08, halfHeight * 0.25)
    this.viewport.centerX = clamp(
      this.viewport.centerX,
      -padX + halfWidth,
      this.manifest.width + padX - halfWidth,
    )
    this.viewport.centerY = clamp(
      this.viewport.centerY,
      -padY + halfHeight,
      this.manifest.height + padY - halfHeight,
    )
  }

  panByScreenDelta(dxCss: number, dyCss: number, screen: NVSlideScreen): void {
    this.viewport.centerX -= dxCss / this.viewport.scale
    this.viewport.centerY +=
      (this.isYAxisUp() ? 1 : -1) * (dyCss / this.viewport.scale)
    this.clampViewport(screen)
    this._emitChange()
  }

  screenToSlide(
    xCss: number,
    yCss: number,
    screen: NVSlideScreen,
  ): { x: number; y: number } {
    const left =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const top =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const y = this.isYAxisUp()
      ? this.viewport.centerY -
        (yCss - screen.heightCss / 2) / this.viewport.scale
      : top + yCss / this.viewport.scale
    return {
      x: left + xCss / this.viewport.scale,
      y,
    }
  }

  zoomBy(
    factor: number,
    anchorXCss: number,
    anchorYCss: number,
    screen: NVSlideScreen,
  ): void {
    const before = this.screenToSlide(anchorXCss, anchorYCss, screen)
    this.viewport.scale *= factor
    this.clampViewport(screen)
    const left = before.x - anchorXCss / this.viewport.scale
    const top = before.y - anchorYCss / this.viewport.scale
    this.viewport.centerX = left + screen.widthCss / (2 * this.viewport.scale)
    this.viewport.centerY = this.isYAxisUp()
      ? before.y + (anchorYCss - screen.heightCss / 2) / this.viewport.scale
      : top + screen.heightCss / (2 * this.viewport.scale)
    this.clampViewport(screen)
    this._emitChange()
  }

  selectLevel(): NVSlideLevelManifest | null {
    if (typeof this.levelChoice === 'number') {
      return (
        this.manifest.levels.find(
          (level) => level.index === this.levelChoice,
        ) ?? null
      )
    }
    for (const level of this.manifest.levels) {
      if (
        this.viewport.scale * level.downsample >=
        this.targetScreenPixelsPerTilePixel
      ) {
        return level
      }
    }
    return this.manifest.levels[this.manifest.levels.length - 1] ?? null
  }

  sourceLabelForLevel(level: NVSlideLevelManifest): string {
    return level.fileUrl ?? this.manifest.dataUrl ?? this.manifestUrl
  }

  screenRectForSlide(screen: NVSlideScreen): NVSlideScreenRect {
    const dpr = screen.devicePixelRatio ?? 1
    const screenScale = this.viewport.scale * dpr
    const viewLeft =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const viewTop =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const viewBottom =
      this.viewport.centerY + screen.heightCss / (2 * this.viewport.scale)
    return {
      x: -viewLeft * screenScale,
      y: this.isYAxisUp()
        ? (viewBottom - this.manifest.height) * screenScale
        : -viewTop * screenScale,
      width: this.manifest.width * screenScale,
      height: this.manifest.height * screenScale,
    }
  }

  visibleTiles(screen: NVSlideScreen): NVSlideVisibleTiles {
    const level = this.selectLevel()
    if (!level) return { level: null, tiles: [] }
    const dpr = screen.devicePixelRatio ?? 1
    const viewLeft =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const viewTop =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const viewRight =
      this.viewport.centerX + screen.widthCss / (2 * this.viewport.scale)
    const viewBottom =
      this.viewport.centerY + screen.heightCss / (2 * this.viewport.scale)
    // Map level pixels <-> base pixels by each level's ACTUAL per-axis scale
    // (base / level dims), not the nominal `downsample`. When a pyramid level's
    // dimensions are not an exact `base / 2^L` (rounding), `level.width *
    // downsample != base width`, so a downsample-based mapping places the level's
    // tiles over a slightly different base extent than the true [0, base] the
    // drawing overlay (screenToSlide/slideToCss) uses — and the offset changes at
    // each LOD boundary, so annotations appear to jump when zooming across a
    // level. Using the exact scale makes every level cover exactly [0, base], so
    // tiles register with each other and with slide-space drawings across zoom.
    const dsX =
      level.width > 0 ? this.manifest.width / level.width : level.downsample
    const dsY =
      level.height > 0 ? this.manifest.height / level.height : level.downsample
    const levelLeft = Math.floor(viewLeft / dsX)
    const levelTop = Math.floor(viewTop / dsY)
    const levelRight = Math.ceil(viewRight / dsX)
    const levelBottom = Math.ceil(viewBottom / dsY)
    const tileWidth = this.levelTileWidth(level)
    const tileHeight = this.levelTileHeight(level)
    const firstX = clamp(
      Math.floor(levelLeft / tileWidth),
      0,
      level.columns - 1,
    )
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
    const screenScale = this.viewport.scale * dpr
    const tiles: NVSlideVisibleTile[] = []

    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const tile = this.tileAt(level, x, y)
        if (!tile) continue
        const baseX = tile.x * tileWidth * dsX
        const baseY = tile.y * tileHeight * dsY
        const baseWidth = tile.width * dsX
        const baseHeight = tile.height * dsY
        const screenY = this.isYAxisUp()
          ? (viewBottom - (baseY + baseHeight)) * screenScale
          : (baseY - viewTop) * screenScale
        tiles.push({
          slide: this,
          level,
          tile,
          key: this.tileKey(level, tile),
          screenX: (baseX - viewLeft) * screenScale,
          screenY,
          screenWidth: baseWidth * screenScale,
          screenHeight: baseHeight * screenScale,
          flipY: this.isYAxisUp(),
        })
      }
    }
    return { level, tiles }
  }

  requestVisibleTiles(screen: NVSlideScreen): NVSlideVisibleTiles {
    const visible = this.visibleTiles(screen)
    if (!this.visible || !visible.level) return visible
    for (const item of visible.tiles) {
      if (this._cache.has(item.key) || this._pending.has(item.key)) continue
      void this.loadTile(item.level, item.tile)
    }
    return visible
  }

  /**
   * Begin loading one tile (no-op if already cached or in flight). For renderers
   * whose working set is driven by something other than the 2D viewport — e.g.
   * the 3D slide-plane render, where visibility comes from world geometry.
   */
  requestTile(level: NVSlideLevelManifest, tile: NVSlideTileManifest): void {
    const key = this.tileKey(level, tile)
    if (this._cache.has(key) || this._pending.has(key)) return
    void this.loadTile(level, tile)
  }

  cachedTileBitmap(key: string): ImageBitmap | null {
    const entry = this._cache.get(key)
    if (!entry) return null
    this.stats.cacheHits++
    return entry.bitmap
  }

  clearCache(): void {
    this._cache.clear()
    this.stats.cacheBytes = 0
    this._emitChange()
  }

  dispose(): void {
    this.clearCache()
    this._pending.clear()
  }

  private levelTileWidth(level: NVSlideLevelManifest): number {
    return level.tileWidth ?? this.manifest.tileSize ?? 1
  }

  private levelTileHeight(level: NVSlideLevelManifest): number {
    return level.tileHeight ?? this.manifest.tileSize ?? 1
  }

  private tileAt(
    level: NVSlideLevelManifest,
    x: number,
    y: number,
  ): NVSlideTileManifest | null {
    if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) return null
    return level.tiles[y * level.columns + x] ?? null
  }

  private tileKey(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): string {
    return `L${level.index}/${tile.x}/${tile.y}`
  }

  private resolveUrl(url: string): string {
    const base =
      this.manifestUrl ||
      (typeof window !== 'undefined'
        ? window.location.href
        : 'http://localhost/')
    return new URL(url, base).toString()
  }

  /**
   * Register a tile decoder for a codec (e.g. `image/jp2` via OpenJPEG WASM).
   * Lets a consumer add codecs the browser can't decode natively without
   * bundling them into the core. Overrides any existing decoder for that codec.
   */
  static registerTileDecoder(codec: string, decoder: SlideTileDecoder): void {
    tileDecoders.set(codec, decoder)
  }

  /** The decoder registered for a codec, or undefined. */
  static tileDecoder(codec: string): SlideTileDecoder | undefined {
    return tileDecoders.get(codec)
  }

  private async decodeTileBitmap(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    tileBytes: Uint8Array,
  ): Promise<ImageBitmap> {
    const codec = level.codec ?? 'raw-rgba'
    const decoder = tileDecoders.get(codec)
    if (!decoder) {
      throw new Error(
        `No decoder for tile codec "${codec}". ` +
          'Register one with NVSlide.registerTileDecoder() ' +
          '(e.g. an OpenJPEG WASM decoder for image/jp2).',
      )
    }
    return decoder(tileBytes, { width: tile.width, height: tile.height })
  }

  private async loadTile(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): Promise<void> {
    const key = this.tileKey(level, tile)
    if (this._cache.has(key) || this._pending.has(key)) return
    this._pending.add(key)
    this.stats.requested++
    const label = `${key}${typeof tile.frame === 'number' ? ` f${tile.frame}` : ''}`
    this._emitChange()

    try {
      const tileBytes = await this._source.fetchTileBytes(level, tile, label)
      this.stats.decodedBytes += tileBytes.byteLength
      const bitmap = await this.decodeTileBitmap(level, tile, tileBytes)
      this._cache.set(key, { bitmap, bytes: tileBytes.byteLength })
      this.stats.cacheBytes = this._cache.bytes
      this.stats.completed++
    } catch (err) {
      this.stats.failures++
      this.updateRangeEvent(label, 'failed')
      console.error(`Failed to load slide tile ${this.id}/${key}`, err)
    } finally {
      this._pending.delete(key)
      this._emitChange()
    }
  }

  private pushRangeEvent(event: NVSlideRangeEvent): void {
    this.stats.lastRequests.push(event)
    while (this.stats.lastRequests.length > this._rangeLogLength) {
      this.stats.lastRequests.shift()
    }
  }

  private updateRangeEvent(label: string, status: NVSlideRangeStatus): void {
    const existing = this.stats.lastRequests.findLast(
      (event) => event.label === label,
    )
    if (existing) {
      existing.status = status
    } else {
      this.pushRangeEvent({ label, status })
    }
  }

  private _emitChange(): void {
    this.dispatchEvent(new Event('change'))
  }
}
