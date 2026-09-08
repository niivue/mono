import { afterEach, describe, expect, it } from 'bun:test'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideRangeEvent,
  NVSlideTileManifest,
  SlideTileSource,
} from './NVSlide'
import { ManifestRangeSource, NVSlide } from './NVSlide'

const TILE_W = 8
const TILE_H = 4
const DECODED_TILE_BYTES = TILE_W * TILE_H * 4

function makeManifest(tileCount: number): NVSlideManifest {
  const tiles: NVSlideTileManifest[] = []
  for (let x = 0; x < tileCount; x++) {
    tiles.push({ x, y: 0, width: TILE_W, height: TILE_H, frame: x + 1 })
  }
  return {
    id: 'test-slide',
    name: 'Test slide',
    width: TILE_W * tileCount,
    height: TILE_H,
    tileSize: TILE_W,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    levels: [
      {
        index: 0,
        width: TILE_W * tileCount,
        height: TILE_H,
        downsample: 1,
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        columns: tileCount,
        rows: 1,
        codec: 'image/jpeg',
        tiles,
      },
    ],
  }
}

// A tile source that resolves each fetch on a timer and records how many
// fetches are outstanding at once.
class CountingSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  current = 0
  peak = 0
  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }
  bind(): void {}
  fetchTileBytes(
    _level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): Promise<Uint8Array> {
    this.current++
    this.peak = Math.max(this.peak, this.current)
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.current--
        if (tile.frame === -1) reject(new Error('tile fetch failed'))
        else resolve(new Uint8Array(16))
      }, 1)
    })
  }
}

const fakeBitmap = () =>
  ({ width: TILE_W, height: TILE_H, close() {} }) as unknown as ImageBitmap

const originalJpegDecoder = NVSlide.tileDecoder('image/jpeg')

afterEach(() => {
  if (originalJpegDecoder) {
    NVSlide.registerTileDecoder('image/jpeg', originalJpegDecoder)
  }
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('NVSlide tile loading', () => {
  it('caps concurrent fetch+decode at maxConcurrentLoads and completes all tiles', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const tileCount = 30
    const source = new CountingSource(makeManifest(tileCount))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    expect(slide.pendingCount).toBe(tileCount)
    await waitFor(() => slide.stats.completed === tileCount)
    expect(source.peak).toBeLessThanOrEqual(4)
    expect(slide.pendingCount).toBe(0)
    expect(slide.stats.failures).toBe(0)
    slide.dispose()
  })

  it('keeps the cap when maxConcurrentLoads is Infinity or NaN', async () => {
    // Neither value raises the cap, they remove it: every capacity test is
    // `_activeLoads >= cap`, false for both, so nothing is ever queued and all
    // 30 tiles go straight to _runLoad. Both must fall back to the default.
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
      const tileCount = 30
      const source = new CountingSource(makeManifest(tileCount))
      const slide = NVSlide.fromSource(source, { maxConcurrentLoads: bad })
      const level = slide.manifest.levels[0]
      if (!level) throw new Error('manifest has no level')
      for (const tile of level.tiles) slide.requestTile(level, tile)
      await waitFor(() => slide.stats.completed === tileCount)
      expect(source.peak).toBeLessThanOrEqual(12)
      expect(slide.stats.failures).toBe(0)
      slide.dispose()
    }
  })

  it('accounts the cache in decoded (RGBA) bytes, not encoded bytes', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const tileCount = 5
    const source = new CountingSource(makeManifest(tileCount))
    const slide = NVSlide.fromSource(source)
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => slide.stats.completed === tileCount)
    // Encoded payload is 16 bytes/tile; decoded accounting must dominate.
    expect(slide.cacheBytes).toBe(tileCount * DECODED_TILE_BYTES)
    expect(slide.stats.decodedBytes).toBe(tileCount * DECODED_TILE_BYTES)
    slide.dispose()
  })

  it('drops queued tiles that leave the working set instead of fetching them', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new CountingSource(makeManifest(30))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    // A viewport pass wants all 30 (1 in flight, 29 queued), so every queued
    // tile is VIEWPORT-origin ...
    slide.setViewport({
      centerX: (TILE_W * 30) / 2,
      centerY: TILE_H / 2,
      scale: 1,
    })
    slide.requestVisibleTiles({ widthCss: TILE_W * 30, heightCss: TILE_H })
    // ... then the view moves on: only tile 0 remains visible. The screen is
    // sized so exactly one tile is in view at the origin.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    await waitFor(() => slide.pendingCount === 0)
    // Only the tile already in flight (tile 0, also the visible one) loads;
    // the 29 stale viewport-origin queued tiles are dropped, not fetched.
    expect(slide.stats.completed).toBe(1)
    expect(source.peak).toBe(1)
    expect(slide.stats.failures).toBe(0)
    slide.dispose()
  })

  it('drains the queue past failed tiles', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const manifest = makeManifest(10)
    const level0 = manifest.levels[0]
    if (!level0) throw new Error('manifest has no level')
    // Mark three tiles as failing (frame -1 makes CountingSource reject).
    for (const i of [2, 5, 7]) {
      const tile = level0.tiles[i]
      if (tile) tile.frame = -1
    }
    const source = new CountingSource(manifest)
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 2 })
    for (const tile of level0.tiles) slide.requestTile(level0, tile)
    await waitFor(() => slide.stats.completed + slide.stats.failures === 10)
    expect(slide.stats.completed).toBe(7)
    expect(slide.stats.failures).toBe(3)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })
})

describe('NVSlide screen<->slide projection', () => {
  const screen = { widthCss: 800, heightCss: 600, devicePixelRatio: 2 }

  for (const displayYAxis of ['down', 'up'] as const) {
    it(`slideToScreen is the inverse of screenToSlide (yAxis ${displayYAxis})`, () => {
      const manifest = makeManifest(6)
      manifest.displayYAxis = displayYAxis
      const slide = NVSlide.fromSource(new CountingSource(manifest))
      // A panned + zoomed viewport (not the fit default) to exercise all terms.
      slide.viewport.centerX = 17.5
      slide.viewport.centerY = 9.25
      slide.viewport.scale = 3.5

      for (const [xCss, yCss] of [
        [0, 0],
        [400, 300],
        [799, 599],
        [123.4, 456.7],
      ]) {
        const s = slide.screenToSlide(xCss, yCss, screen)
        const back = slide.slideToScreen(s.x, s.y, screen)
        expect(back.xCss).toBeCloseTo(xCss, 6)
        expect(back.yCss).toBeCloseTo(yCss, 6)
      }
      slide.dispose()
    })
  }
})

// A three-level pyramid over a 32 x 16 base, every level tiled 8 x 4:
// L0 = 4 x 4 tiles, L1 = 2 x 2 tiles, L2 = 1 x 1 tile.
function makePyramid(): NVSlideManifest {
  const levels: NVSlideLevelManifest[] = []
  for (const [index, downsample] of [
    [0, 1],
    [1, 2],
    [2, 4],
  ] as const) {
    const width = 32 / downsample
    const height = 16 / downsample
    const columns = Math.ceil(width / TILE_W)
    const rows = Math.ceil(height / TILE_H)
    const tiles: NVSlideTileManifest[] = []
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        tiles.push({ x, y, width: TILE_W, height: TILE_H, frame: 1 })
      }
    }
    levels.push({
      index,
      width,
      height,
      downsample,
      tileWidth: TILE_W,
      tileHeight: TILE_H,
      columns,
      rows,
      codec: 'image/jpeg',
      tiles,
    })
  }
  return {
    id: 'pyramid-slide',
    name: 'Pyramid slide',
    width: 32,
    height: 16,
    tileSize: TILE_W,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    levels,
  }
}

// Whole slide in view at 1:1, so every level's tiles cover the viewport.
const WHOLE_SLIDE_SCREEN = { widthCss: 32, heightCss: 16 }

async function loadLevel(slide: NVSlide, levelIndex: number): Promise<void> {
  const before = slide.stats.completed
  const level = slide.manifest.levels[levelIndex]
  if (!level) throw new Error(`no level ${levelIndex}`)
  slide.setLevelChoice(levelIndex)
  slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
  await waitFor(() => slide.stats.completed === before + level.tiles.length)
}

describe('NVSlide coarse fallback layer', () => {
  it('offers cached coarser tiles, coarsest first, while the target level loads', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new CountingSource(makePyramid())
    const slide = NVSlide.fromSource(source)
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    await loadLevel(slide, 2)
    await loadLevel(slide, 1)

    // Switch to the finest level: none of its 16 tiles are cached yet, so the
    // renderer must be handed the coarse tiles standing in for them.
    slide.setLevelChoice(0)
    const visible = slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.level?.index).toBe(0)
    expect(visible.tiles.length).toBe(16)
    // L2's single tile, then L1's four: painting in array order lets each
    // finer level overpaint the one below it.
    expect(visible.fallback.map((item) => item.level.index)).toEqual([
      2, 1, 1, 1, 1,
    ])

    await waitFor(() => slide.stats.completed === 21)
    // Every target tile is cached now, so the fallback layer costs nothing.
    expect(slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN).fallback).toEqual([])
    slide.dispose()
  })

  it('never fetches for the fallback layer', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new CountingSource(makePyramid())
    const slide = NVSlide.fromSource(source)
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    await loadLevel(slide, 2)

    // L1 was never loaded, so it contributes nothing: the fallback layer draws
    // what is already decoded and leaves the load slots to the target level.
    slide.setLevelChoice(0)
    const requestedBefore = slide.stats.requested
    const visible = slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.fallback.map((item) => item.level.index)).toEqual([2])
    expect(slide.stats.requested - requestedBefore).toBe(16)
    slide.dispose()
  })

  it('has no fallback at the coarsest level', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new CountingSource(makePyramid())
    const slide = NVSlide.fromSource(source)
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(2)
    expect(slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN).fallback).toEqual([])
    slide.dispose()
  })
})

// A tile source that honours the AbortSignal: a pending fetch rejects with an
// AbortError the moment NVSlide aborts it, and every signal is recorded.
// A tile source that honours the AbortSignal and completes only when the test
// releases it, so in-flight counts are deterministic regardless of scheduler
// timing (a timer-based source flakes on slow CI runners: loads can complete
// between a waitFor and the next assertion).
class AbortableSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  readonly signals: AbortSignal[] = []
  private readonly gates: Array<() => void> = []
  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }
  bind(): void {}
  /** Resolve every fetch that has not been aborted. */
  releaseAll(): void {
    for (const release of this.gates.splice(0)) release()
  }
  fetchTileBytes(
    _level: NVSlideLevelManifest,
    _tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal) this.signals.push(signal)
    return new Promise((resolve, reject) => {
      this.gates.push(() => resolve(new Uint8Array(16)))
      signal?.addEventListener('abort', () => {
        reject(new DOMException('tile fetch aborted', 'AbortError'))
      })
    })
  }
}

describe('NVSlide load cancellation', () => {
  it('passes an AbortSignal to the source and aborts in-flight loads on dispose', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(4))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => source.signals.length === 4)
    expect(source.signals.every((s) => !s.aborted)).toBe(true)
    slide.dispose()
    source.releaseAll()
    expect(source.signals.every((s) => s.aborted)).toBe(true)
    await waitFor(() => slide.stats.aborted === 4)
    // An abort is not a failure and nothing was cached.
    expect(slide.stats.failures).toBe(0)
    expect(slide.stats.completed).toBe(0)
    expect(slide.pendingCount).toBe(0)
  })

  it('aborts in-flight viewport loads that leave the working set and re-requests them later', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(30))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 8 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    // All 30 tiles in view: 8 in flight, 22 queued, all viewport-initiated ...
    slide.requestVisibleTiles({ widthCss: TILE_W * 30, heightCss: TILE_H })
    await waitFor(() => source.signals.length === 8)
    // ... then only tile 0 stays visible: the other 7 in-flight loads are
    // abandoned on the wire, the queued ones are dropped at dequeue time.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    expect(source.signals.filter((s) => s.aborted).length).toBe(7)
    source.releaseAll()
    await waitFor(() => slide.pendingCount === 0)
    expect(slide.stats.completed).toBe(1)
    expect(slide.stats.aborted).toBe(7)
    expect(slide.stats.failures).toBe(0)
    // An aborted tile is not poisoned: bringing it back into view refetches.
    const before = source.signals.length
    slide.setViewport({ centerX: TILE_W * 1.5, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    await waitFor(() => source.signals.length === before + 1)
    source.releaseAll()
    await waitFor(() => slide.stats.completed === 2)
    expect(source.signals.length).toBe(before + 1)
    slide.dispose()
  })

  it('lets a requestTile()-initiated in-flight load finish when the viewport moves on', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(4))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    // A non-viewport consumer (e.g. setSlidePlane's coarsest-level priming)
    // starts all four loads ...
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => source.signals.length === 4)
    // ... then a 2D viewport pass wants only tile 0. The other three loads
    // were not started by the viewport working set, so they must NOT be
    // aborted: they complete and populate the cache for their consumer.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    expect(source.signals.some((s) => s.aborted)).toBe(false)
    source.releaseAll()
    await waitFor(() => slide.stats.completed === 4)
    expect(slide.stats.aborted).toBe(0)
    expect(slide.cacheBytes).toBe(4 * DECODED_TILE_BYTES)
    slide.dispose()
  })

  it('lets a requestTile()-initiated QUEUED load survive a viewport pass that drops it', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(2))
    // One load slot, so the second requestTile() tile stays QUEUED behind the
    // first (deterministic: which tile is in flight vs queued is fixed).
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    // A non-viewport consumer requests both: tile 0 in flight, tile 1 queued.
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => source.signals.length === 1)
    // A 2D viewport pass then wants only tile 0. It clears and rebuilds the
    // working set, so the queued tile 1 is no longer "wanted" -- but it was
    // queued by requestTile(), not the viewport, so it must NOT be dropped.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    // Releasing tile 0 drains the queue: tile 1 must start (not be dropped).
    source.releaseAll()
    await waitFor(() => source.signals.length === 2)
    source.releaseAll()
    await waitFor(() => slide.stats.completed === 2)
    expect(slide.stats.aborted).toBe(0)
    expect(slide.stats.failures).toBe(0)
    expect(source.signals.some((s) => s.aborted)).toBe(false)
    expect(slide.cacheBytes).toBe(2 * DECODED_TILE_BYTES)
    slide.dispose()
  })

  it('keeps a viewport-started load that requestTile() also claimed', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(4))
    // maxConcurrentLoads == tile count, so every tile is in flight (no queue):
    // which loads are live when the viewport narrows is then deterministic.
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    // The viewport starts all four loads (widthCss spans the whole slide) ...
    slide.setViewport({
      centerX: (TILE_W * 4) / 2,
      centerY: TILE_H / 2,
      scale: 1,
    })
    slide.requestVisibleTiles({ widthCss: TILE_W * 4, heightCss: TILE_H })
    await waitFor(() => source.signals.length === 4)
    // ... then another consumer explicitly claims tile 1 (already in flight) ...
    const claimed = level.tiles[1]
    if (!claimed) throw new Error('missing tile')
    slide.requestTile(level, claimed)
    // ... and the viewport moves away from everything but tile 0.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    // Only tiles 2 and 3 abort; tile 0 (visible) and tile 1 (claimed) survive.
    expect(source.signals.filter((s) => s.aborted).length).toBe(2)
    source.releaseAll()
    await waitFor(() => slide.pendingCount === 0)
    expect(slide.stats.completed).toBe(2)
    expect(slide.stats.aborted).toBe(2)
    slide.dispose()
  })

  it('discards bytes a source resolves after its signal was aborted', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    // A source that ignores the signal entirely (third-party, pre-signal API).
    const source = new CountingSource(makeManifest(2))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 2 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => source.current === 2)
    slide.dispose()
    await waitFor(() => source.current === 0)
    await waitFor(() => slide.stats.aborted === 2)
    expect(slide.stats.completed).toBe(0)
    expect(slide.stats.failures).toBe(0)
    expect(slide.cacheBytes).toBe(0)
  })

  it('closes a bitmap whose decode outlives the abort instead of caching it', async () => {
    // The abort can also land between the fetch resolving and the decode
    // finishing. The freshly decoded bitmap must be closed, not inserted into
    // a cache that dispose() has already cleared (nobody would ever close it).
    let closed = 0
    let decodeStarted = false
    let releaseDecode = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseDecode = resolve
    })
    NVSlide.registerTileDecoder('image/jpeg', async () => {
      decodeStarted = true
      await gate
      return {
        width: TILE_W,
        height: TILE_H,
        close() {
          closed++
        },
      } as unknown as ImageBitmap
    })
    const source: SlideTileSource = {
      manifest: makeManifest(1),
      bind() {},
      fetchTileBytes: () => Promise.resolve(new Uint8Array(16)),
    }
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    slide.requestTile(level, tile)
    await waitFor(() => decodeStarted)
    slide.dispose()
    releaseDecode()
    await waitFor(() => slide.stats.aborted === 1)
    expect(closed).toBe(1)
    expect(slide.stats.completed).toBe(0)
    expect(slide.stats.failures).toBe(0)
    expect(slide.cacheBytes).toBe(0)
  })
})

// A one-tile byte-range manifest for exercising ManifestRangeSource directly.
function makeRangeManifest(): NVSlideManifest {
  return {
    id: 'range-slide',
    name: 'Range slide',
    width: TILE_W,
    height: TILE_H,
    tileSize: TILE_W,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    dataUrl: 'https://example.test/slide.bin',
    levels: [
      {
        index: 0,
        width: TILE_W,
        height: TILE_H,
        downsample: 1,
        columns: 1,
        rows: 1,
        codec: 'image/jpeg',
        tiles: [
          { x: 0, y: 0, width: TILE_W, height: TILE_H, offset: 0, length: 16 },
        ],
      },
    ],
  }
}

describe('ManifestRangeSource range telemetry', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Bind the source to a host whose event log mirrors NVSlide's
  // push/updateRangeEvent semantics (update the newest entry with the label).
  function bindSource(): {
    source: ManifestRangeSource
    events: NVSlideRangeEvent[]
  } {
    const source = new ManifestRangeSource(makeRangeManifest())
    const events: NVSlideRangeEvent[] = []
    source.bind({
      resolveUrl: (url) => url,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent: (event) => {
        events.push(event)
      },
      updateRangeEvent: (label, status) => {
        const existing = events.findLast((event) => event.label === label)
        if (existing) existing.status = status
        else events.push({ label, status })
      },
    })
    return { source, events }
  }

  function onlyTile(source: ManifestRangeSource): {
    level: NVSlideLevelManifest
    tile: NVSlideTileManifest
  } {
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    return { level, tile }
  }

  it('marks the fragment range event aborted, not pending, when the fetch aborts', async () => {
    const { source, events } = bindSource()
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = (() =>
      Promise.reject(
        new DOMException('fetch aborted', 'AbortError'),
      )) as unknown as typeof fetch
    const { level, tile } = onlyTile(source)
    await expect(
      source.fetchTileBytes(level, tile, 'L0/0/0', controller.signal),
    ).rejects.toThrow('fetch aborted')
    // The 'pending' entry must not survive the rejected fetch.
    expect(events).toEqual([{ label: 'L0/0/0 0-15', status: 'aborted' }])
  })

  it('marks the fragment range event failed when the fetch rejects', async () => {
    const { source, events } = bindSource()
    globalThis.fetch = (() =>
      Promise.reject(new TypeError('network down'))) as unknown as typeof fetch
    const { level, tile } = onlyTile(source)
    await expect(source.fetchTileBytes(level, tile, 'L0/0/0')).rejects.toThrow(
      'network down',
    )
    expect(events).toEqual([{ label: 'L0/0/0 0-15', status: 'failed' }])
  })
})
