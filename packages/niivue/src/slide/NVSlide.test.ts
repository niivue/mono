import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { log } from '@/logger'
import type {
  NVSlideColorLut,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideRangeEvent,
  NVSlideTileManifest,
  SlideTileSource,
} from './NVSlide'
import {
  assertSingleSlidePlane,
  ManifestRangeSource,
  NVSlide,
  windowSamples,
} from './NVSlide'

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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
      for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
    for (const tile of level0.tiles) if (tile) slide.requestTile(level0, tile)
    await waitFor(() => slide.stats.completed + slide.stats.failures === 10)
    expect(slide.stats.completed).toBe(7)
    expect(slide.stats.failures).toBe(3)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })
})

describe('NVSlide screen<->slide projection', () => {
  const screen = { widthCss: 800, heightCss: 600, devicePixelRatio: 2 }

  it('clampViewport keeps a fitted slide centred on its loose axis', () => {
    // 48x4 slide on an 800x600 screen: fit is width-bound, so the view is far
    // taller than the slide and the vertical clamp range inverts.
    const slide = NVSlide.fromSource(new CountingSource(makeManifest(6)))
    slide.fitToScreen(screen)
    slide.clampViewport(screen)
    expect(slide.viewport.centerX).toBeCloseTo(24, 6)
    expect(slide.viewport.centerY).toBeCloseTo(2, 6)
    slide.dispose()
  })

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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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
    for (const tile of level.tiles) if (tile) slide.requestTile(level, tile)
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

describe('ManifestRangeSource per-tile file', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reads a tile from its own fileUrl (a DICOM concatenation)', async () => {
    const manifest = makeRangeManifest()
    const level = manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    tile.fileUrl = 'https://example.test/part2.bin'
    const source = new ManifestRangeSource(manifest)
    source.bind({
      resolveUrl: (url) => url,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent() {},
      updateRangeEvent() {},
    })
    const urls: string[] = []
    globalThis.fetch = ((url: string) => {
      urls.push(url)
      return Promise.resolve(
        new Response(new Uint8Array(16), {
          status: 206,
          headers: { 'content-range': 'bytes 0-15/100' },
        }),
      )
    }) as unknown as typeof fetch
    await source.fetchTileBytes(level, tile, 'L0/0/0')
    expect(urls).toEqual(['https://example.test/part2.bin'])
  })
})

describe('NVSlide listed tiles', () => {
  it('places a level that lists only its present tiles, holes null', () => {
    const manifest = makePyramid()
    const l0 = manifest.levels[0]
    if (!l0) throw new Error('no level')
    const a = { x: 1, y: 0, width: TILE_W, height: TILE_H, frame: 1 }
    const b = { x: 3, y: 2, width: TILE_W, height: TILE_H, frame: 2 }
    Object.assign(l0, { tiles: [b, a], sparse: true })
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    const placed = slide.manifest.levels[0]
    if (!placed) throw new Error('no level')
    expect(placed.tiles.length).toBe(16)
    expect(placed.tiles[1]).toBe(a)
    expect(placed.tiles[2 * 4 + 3]).toBe(b)
    expect(placed.tiles.filter((t) => t === null).length).toBe(14)
    expect(l0.tiles).toEqual([b, a]) // the caller's manifest is not changed
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(0)
    expect(slide.visibleTiles(WHOLE_SLIDE_SCREEN).tiles.length).toBe(2)
    slide.dispose()
  })

  it('drops off-grid and duplicate tiles, and places a complete sparse level by x/y', () => {
    const manifest = makePyramid()
    const l1 = manifest.levels[1] // 2 x 2 tiles
    if (!l1) throw new Error('no level')
    const at = (x: number, y: number, frame: number) => ({
      x,
      y,
      width: TILE_W,
      height: TILE_H,
      frame,
    })
    // Four tiles, so the count matches the grid, but listed out of order, with
    // a duplicate cell, an off-grid tile and a non-integer position.
    Object.assign(l1, {
      sparse: true,
      tiles: [at(1, 1, 1), at(1, 1, 2), at(2, 0, 3), at(0.5, 0, 4)],
    })
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    const placed = slide.manifest.levels[1]
    expect(placed?.tiles.map((t) => t?.frame ?? null)).toEqual([
      null,
      null,
      null,
      1,
    ])
    slide.dispose()
  })
})

describe('NVSlide DICOM-WSI dimensions', () => {
  // `grids`: frames as a multiple of the level's tile grid (undefined = no count).
  const dicom = (
    grids: number | undefined,
    paths?: number,
    planes?: number,
  ): NVSlideManifest => {
    const m = makeManifest(2)
    m.format = 'dicom-wsi-range-v1'
    for (const level of m.levels) {
      level.frames =
        grids === undefined ? undefined : grids * level.columns * level.rows
      level.opticalPaths = paths
      level.focalPlanes = planes
    }
    return m
  }

  it('accepts tags of one each that the frame count confirms', () => {
    expect(() => assertSingleSlidePlane(dicom(1, 1, 1))).not.toThrow()
  })

  it('proves one of each from the frame count when the tags are absent', () => {
    expect(() => assertSingleSlidePlane(dicom(1))).not.toThrow()
  })

  it('refuses dimensions nothing proves', () => {
    for (const m of [dicom(undefined), dicom(2), dicom(2, 1, 1), dicom(3, 3)])
      expect(() => assertSingleSlidePlane(m)).toThrow(/unknown or disagree/)
  })

  it('refuses several optical paths or focal planes, before any layout', () => {
    expect(() => assertSingleSlidePlane(dicom(3, 3, 1))).toThrow(
      /3 optical paths/,
    )
    expect(() =>
      NVSlide.fromSource(new CountingSource(dicom(5, 1, 5))),
    ).toThrow(/5 focal planes/)
  })

  it('leaves formats without these dimensions alone', () => {
    expect(() => assertSingleSlidePlane(makeManifest(2))).not.toThrow()
  })
})

describe('NVSlide tile decoder context', () => {
  const originalJp2 = NVSlide.tileDecoder('image/jp2')
  afterEach(() => {
    if (originalJp2) NVSlide.registerTileDecoder('image/jp2', originalJp2)
  })

  it('passes the level and an abort signal', async () => {
    const seen: string[] = []
    NVSlide.registerTileDecoder(
      'image/jp2',
      async (_bytes, { level, signal }) => {
        seen.push(
          level.photometric ?? '',
          String(signal instanceof AbortSignal),
        )
        return fakeBitmap()
      },
    )
    const manifest = makeManifest(1)
    const level = manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    level.codec = 'image/jp2'
    level.photometric = 'YBR_FULL_422'
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    const tile = level.tiles[0]
    if (!tile) throw new Error('level has no tile')
    slide.requestTile(slide.manifest.levels[0] ?? level, tile)
    await waitFor(() => slide.stats.completed === 1)
    expect(seen).toEqual(['YBR_FULL_422', 'true'])
    slide.dispose()
  })
})

describe('NVSlide tile-cache budget', () => {
  it('shows the finest coarser level whose visible tiles fit the cache', () => {
    // 128 decoded bytes per tile: L0 needs 16 tiles (2048 B), L1 4 (512 B).
    const slide = NVSlide.fromSource(new CountingSource(makePyramid()), {
      maxCacheBytes: 700, // 75% budget: 525 B
    })
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(0)
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const visible = slide.visibleTiles(WHOLE_SLIDE_SCREEN)
    slide.visibleTiles(WHOLE_SLIDE_SCREEN) // the next frame does not warn again
    expect(visible.level?.index).toBe(1)
    expect(visible.requestedLevel?.index).toBe(0)
    expect(visible.tiles.length).toBe(4)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('showing L1')
    warn.mockRestore()
    slide.dispose()
  })

  it('charges full decoded tiles, not clipped edge extents', () => {
    // DICOM edge frames decode padded to the full tile: clipped to 1 px wide,
    // L0's 16 tiles would seem to need 256 B, but decode to 2048 B.
    const manifest = makePyramid()
    for (const tile of manifest.levels[0]?.tiles ?? []) if (tile) tile.width = 1
    const slide = NVSlide.fromSource(new CountingSource(manifest), {
      maxCacheBytes: 700, // 75% budget: 525 B
    })
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(0)
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    expect(slide.visibleTiles(WHOLE_SLIDE_SCREEN).level?.index).toBe(1)
    warn.mockRestore()
    slide.dispose()
  })

  it('reports no requested level when the requested one fits', () => {
    const slide = NVSlide.fromSource(new CountingSource(makePyramid()))
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(0)
    expect(
      slide.visibleTiles(WHOLE_SLIDE_SCREEN).requestedLevel,
    ).toBeUndefined()
    slide.dispose()
  })
})

describe('NVSlide padded frames', () => {
  const originalCreate = globalThis.createImageBitmap
  afterEach(() => {
    globalThis.createImageBitmap = originalCreate
  })

  it('crops padding beyond the tile, at the right and bottom', async () => {
    // A small level stored as one whole frame: 3 x 2 of image in an 8 x 4 frame.
    const manifest = makeManifest(1)
    const level = manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    Object.assign(tile, { width: 3, height: 2 })
    let closedPadded = false
    NVSlide.registerTileDecoder('image/jpeg', async () => {
      const padded = fakeBitmap()
      padded.close = () => {
        closedPadded = true
      }
      return padded
    })
    const crops: number[][] = []
    globalThis.createImageBitmap = (async (
      _src: unknown,
      ...rect: number[]
    ) => {
      crops.push(rect)
      const [, , width, height] = rect
      return { width, height, close() {} }
    }) as unknown as typeof createImageBitmap
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    slide.requestTile(level, tile)
    await waitFor(() => slide.stats.completed === 1)
    expect(crops).toEqual([[0, 0, 3, 2]])
    expect(closedPadded).toBe(true)
    expect(slide.stats.cacheBytes).toBe(3 * 2 * 4) // the crop, not the 8 x 4 frame
    slide.dispose()
  })

  it('leaves a frame that fits its tile alone', async () => {
    const manifest = makeManifest(1)
    const level = manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    let cropped = false
    globalThis.createImageBitmap = (async () => {
      cropped = true
    }) as unknown as typeof createImageBitmap
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    slide.requestTile(level, tile)
    await waitFor(() => slide.stats.completed === 1)
    expect(cropped).toBe(false)
    slide.dispose()
  })
})

describe('NVSlide failed tiles', () => {
  it('back off instead of re-requesting a failing tile on every render', async () => {
    const manifest = makeManifest(1)
    const level = manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('manifest has no tile')
    tile.frame = -1 // CountingSource rejects it
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    const error = spyOn(console, 'error').mockImplementation(() => {})
    let now = performance.now()
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    slide.requestTile(level, tile)
    await waitFor(() => slide.stats.failures === 1)
    for (let i = 0; i < 5; i++) slide.requestTile(level, tile) // renders
    expect(slide.stats.requested).toBe(1)
    now += 1001 // past the 1 s backoff
    slide.requestTile(level, tile)
    await waitFor(() => slide.stats.failures === 2)
    now += 1001 // the second wait is 2 s
    slide.requestTile(level, tile)
    expect(slide.stats.requested).toBe(2)
    clock.mockRestore()
    error.mockRestore()
    slide.dispose()
  })
})

describe('windowSamples', () => {
  const w = { calMin: 100, calMax: 300 }
  it('maps the window to 0..255, clamping outside it', () => {
    const rgba = windowSamples(
      new Uint16Array([50, 100, 200, 300, 400]),
      w,
      false,
    )
    expect([0, 4, 8, 12, 16].map((i) => rgba[i])).toEqual([0, 0, 128, 255, 255])
    expect([rgba[9], rgba[10], rgba[11]]).toEqual([128, 128, 255]) // grey, opaque
  })
  it('inverts MONOCHROME1 after windowing', () => {
    const rgba = windowSamples(new Uint8Array([100, 200, 255]), w, true)
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([255, 127, 57]) // 255 - round(155 * 255 / 200)
  })
})

describe('NVSlide monochrome window', () => {
  // Bun has no ImageData/createImageBitmap: a stand-in bitmap carries its pixels.
  type FakeBitmap = {
    width: number
    height: number
    data: Uint8ClampedArray
    closed: boolean
    close(): void
  }
  const g = globalThis as Record<string, unknown>
  const saved = {
    ImageData: g.ImageData,
    createImageBitmap: g.createImageBitmap,
    OffscreenCanvas: g.OffscreenCanvas,
  }
  beforeEach(() => {
    g.ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    g.createImageBitmap = async (img: {
      data: Uint8ClampedArray
      width: number
      height: number
    }) => {
      const bitmap: FakeBitmap = {
        width: img.width,
        height: img.height,
        data: img.data,
        closed: false,
        close() {
          bitmap.closed = true
        },
      }
      return bitmap
    }
  })
  afterEach(() => {
    Object.assign(g, saved)
    if (originalJls) NVSlide.registerTileDecoder('image/jls', originalJls)
  })
  const originalJls = NVSlide.tileDecoder('image/jls')

  // Every tile holds `value`; 12-bit DICOM BitsStored in a 16-bit codestream.
  function monoSlide(value: number, photometric = 'MONOCHROME2'): NVSlide {
    NVSlide.registerTileDecoder('image/jls', async () => ({
      samples: new Uint16Array(TILE_W * TILE_H).fill(value),
      width: TILE_W,
      height: TILE_H,
      bitsStored: 16,
    }))
    const manifest = makePyramid()
    for (const level of manifest.levels)
      Object.assign(level, { codec: 'image/jls', photometric, bitsStored: 12 })
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    return slide
  }
  const pixel = (slide: NVSlide, key: string) =>
    (slide.cachedTileBitmap(key) as unknown as FakeBitmap | null)?.data[0]

  it('defaults to the level bitsStored range, the same in every tile and level', async () => {
    const slide = monoSlide(4095)
    await loadLevel(slide, 0)
    await loadLevel(slide, 1)
    const values = [
      ...slide.manifest.levels[0].tiles,
      ...slide.manifest.levels[1].tiles,
    ].map((t, i) => pixel(slide, `L${i < 16 ? 0 : 1}/${t?.x}/${t?.y}`))
    expect(new Set(values)).toEqual(new Set([255]))
    // 8x4 RGBA plus 8x4 uint16 samples per tile.
    expect(slide.cacheBytes).toBe(20 * (TILE_W * TILE_H * 6))
    slide.dispose()
  })

  it('crops a padded sample frame to its tile', async () => {
    const slide = monoSlide(4095)
    // A 16 x 8 frame for an 8 x 4 tile: the padding (0) must not reach the bitmap.
    NVSlide.registerTileDecoder('image/jls', async () => {
      const samples = new Uint16Array(16 * 8)
      for (let y = 0; y < TILE_H; y++)
        samples.fill(4095, y * 16, y * 16 + TILE_W)
      return { samples, width: 16, height: 8, bitsStored: 16 }
    })
    await loadLevel(slide, 2)
    const bitmap = slide.cachedTileBitmap('L2/0/0') as unknown as FakeBitmap
    expect([bitmap.width, bitmap.height]).toEqual([TILE_W, TILE_H])
    expect(new Set(bitmap.data.filter((_, i) => i % 4 === 0))).toEqual(
      new Set([255]),
    )
    slide.dispose()
  })

  it('windows a monochrome JPEG from its bitmap, MONOCHROME1 inverted', async () => {
    // The browser's JPEG decoder yields only a grey bitmap: NVSlide reads it back.
    g.OffscreenCanvas = class {
      getContext() {
        let drawn: FakeBitmap | null = null
        return {
          drawImage: (b: FakeBitmap) => {
            drawn = b
          },
          getImageData: () => ({ data: drawn?.data }),
        }
      }
    }
    let jpeg: FakeBitmap | null = null
    NVSlide.registerTileDecoder('image/jpeg', async () => {
      const data = new Uint8ClampedArray(TILE_W * TILE_H * 4).fill(60)
      jpeg = { width: TILE_W, height: TILE_H, data, closed: false, close() {} }
      return jpeg as unknown as ImageBitmap
    })
    const manifest = makePyramid()
    for (const level of manifest.levels)
      Object.assign(level, { photometric: 'MONOCHROME1', bitsStored: 8 })
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    await loadLevel(slide, 2)
    expect(pixel(slide, 'L2/0/0')).toBe(195) // 255 - 60, the default 0..255 window
    slide.setWindow(0, 120)
    await waitFor(() => pixel(slide, 'L2/0/0') === 127) // 255 - round(60 * 255 / 120)
    slide.dispose()
  })

  it('re-windows cached tiles and windows later arrivals the same way', async () => {
    const slide = monoSlide(500)
    await loadLevel(slide, 2)
    const before = slide.cachedTileBitmap('L2/0/0') as unknown as FakeBitmap
    expect(before.data[0]).toBe(31) // round(500 * 255 / 4095)
    slide.setWindow(0, 1000)
    await waitFor(() => pixel(slide, 'L2/0/0') === 128)
    expect(before.closed).toBe(true)
    await loadLevel(slide, 1)
    expect(pixel(slide, 'L1/1/1')).toBe(128)
    expect(slide.window).toEqual({ calMin: 0, calMax: 1000 })
    slide.dispose()
  })

  it('rejects a window that is not finite with calMin < calMax', () => {
    const slide = monoSlide(0)
    for (const [lo, hi] of [
      [5, 5],
      [6, 5],
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
    ] as const)
      expect(() => slide.setWindow(lo, hi)).toThrow(RangeError)
    expect(slide.window).toBeNull()
    slide.dispose()
  })
})

describe('NVSlide sparse levels', () => {
  // TILED_SPARSE: L0 (4 x 4) holds 6 of its 16 tiles; holes are null.
  function sparseManifest(stated = true): NVSlideManifest {
    const m = makePyramid()
    m.format = 'dicom-wsi-index-v1'
    for (const level of m.levels)
      Object.assign(level, {
        sparse: true,
        ...(stated ? { opticalPaths: 1, focalPlanes: 1 } : {}),
        frames: level.index === 0 ? 6 : level.tiles.length,
      })
    const l0 = m.levels[0]
    if (!l0) throw new Error('no L0')
    l0.tiles = l0.tiles.map((t, i) =>
      [0, 3, 5, 6, 10, 15].includes(i) ? t : null,
    )
    return m
  }

  it('opens, and neither draws nor requests a hole', () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const slide = NVSlide.fromSource(new CountingSource(sparseManifest()))
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    slide.setLevelChoice(0)
    const visible = slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.level?.index).toBe(0)
    // Only present tiles are visible (so a renderer draws no placeholder for a hole).
    expect(visible.tiles.map((t) => `${t.tile.x},${t.tile.y}`)).toEqual([
      '0,0',
      '3,0',
      '1,1',
      '2,1',
      '2,2',
      '3,3',
    ])
    expect(slide.stats.requested).toBe(6)
    slide.dispose()
  })

  it('needs the producer to state one optical path and one focal plane', () => {
    expect(() =>
      NVSlide.fromSource(new CountingSource(sparseManifest(false))),
    ).toThrow(/sparse but does not state/)
    // Without `sparse`, its 6 frames would contradict the 4 x 4 grid.
    const unmarked = sparseManifest()
    for (const level of unmarked.levels) delete level.sparse
    expect(() => NVSlide.fromSource(new CountingSource(unmarked))).toThrow(
      /disagree with its frame count/,
    )
  })
})

describe('NVSlide colour management', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    NVSlide.registerIccTransform(null)
    globalThis.fetch = originalFetch
  })
  const lut: NVSlideColorLut = { size: 2, data: new Uint8Array(32).fill(7) }
  const profile = new Uint8Array([1, 2, 3])
  // A source that serves `profile` (or null) as its ICC profile.
  const withProfile = (p: Uint8Array | null): SlideTileSource => ({
    manifest: makeManifest(1),
    bind() {},
    fetchTileBytes: async () => new Uint8Array(0),
    fetchIccProfile: async () => p,
  })
  const changed = (slide: NVSlide) =>
    new Promise<void>((resolve) =>
      slide.addEventListener('change', () => resolve(), { once: true }),
    )

  it('bakes the source profile with the registered transform and announces it', async () => {
    const seen: Uint8Array[] = []
    NVSlide.registerIccTransform(async (p) => {
      seen.push(p)
      return lut
    })
    const slide = NVSlide.fromSource(withProfile(profile))
    await changed(slide)
    expect(seen).toEqual([profile])
    expect(slide.colorLut).toBe(lut)
    expect(slide.displayColorLut).toBe(lut)
  })

  it('shows no table while off, or with no profile, transform or usable table', async () => {
    NVSlide.registerIccTransform(async () => lut)
    const off = NVSlide.fromSource(withProfile(profile), {
      colorManagement: false,
    })
    await changed(off)
    expect(off.displayColorLut).toBeNull()
    off.colorManagement = true
    expect(off.displayColorLut).toBe(lut)

    const none = NVSlide.fromSource(withProfile(null))
    NVSlide.registerIccTransform(async () => null)
    const unusable = NVSlide.fromSource(withProfile(profile))
    NVSlide.registerIccTransform(null)
    const unregistered = NVSlide.fromSource(withProfile(profile))
    await new Promise((r) => setTimeout(r, 0))
    for (const s of [none, unusable, unregistered])
      expect([s.colorLut, s.displayColorLut]).toEqual([null, null])
  })

  it('skips a profile the manifest says is sRGB', async () => {
    let calls = 0
    NVSlide.registerIccTransform(async () => {
      calls++
      return lut
    })
    const source = withProfile(profile)
    const manifest = {
      ...source.manifest,
      iccProfile: { url: 'p', colorSpace: 'SRGB' },
    }
    NVSlide.fromSource({ ...source, manifest })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
  })

  it('skips a monochrome slide: its window is the display mapping', async () => {
    let calls = 0
    NVSlide.registerIccTransform(async () => {
      calls++
      return lut
    })
    const source = withProfile(profile)
    const manifest = {
      ...source.manifest,
      levels: source.manifest.levels.map((l) => ({
        ...l,
        photometric: 'MONOCHROME2',
      })),
    }
    NVSlide.fromSource({ ...source, manifest })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
  })

  it('rejects a table of the wrong length, and keeps none', async () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    NVSlide.registerIccTransform(async () => ({
      size: 2,
      data: new Uint8Array(24),
    })) // RGB, not RGBA
    const slide = NVSlide.fromSource(withProfile(profile))
    await new Promise((r) => setTimeout(r, 0))
    expect(slide.colorLut).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('refuses a table that is not size^3 RGBA8 bytes, or too large', async () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    for (const bad of [
      { size: 2, data: new Float32Array(32) as unknown as Uint8Array },
      { size: 130, data: new Uint8Array(130 ** 3 * 4) },
    ]) {
      NVSlide.registerIccTransform(async () => bad)
      const slide = NVSlide.fromSource(withProfile(profile))
      await new Promise((r) => setTimeout(r, 0))
      expect(slide.colorLut).toBeNull()
    }
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('a manifest profile with only one of offset and length is refused', async () => {
    const source = new ManifestRangeSource({
      ...makeManifest(1),
      iccProfile: { url: 'https://host/f.dcm', offset: 100 },
    })
    source.bind({
      resolveUrl: (u) => u,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent() {},
      updateRangeEvent() {},
    })
    await expect(source.fetchIccProfile()).rejects.toThrow('only one of')
  })

  it('dispose during a bake aborts it and keeps no table', async () => {
    let seen: AbortSignal | undefined
    let finish: (lut: NVSlideColorLut) => void = () => {}
    NVSlide.registerIccTransform((_p, signal) => {
      seen = signal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    expect(NVSlide.iccTransform()).not.toBeNull()
    const slide = NVSlide.fromSource(withProfile(profile))
    await new Promise((r) => setTimeout(r, 0))
    slide.dispose()
    expect(seen?.aborted).toBe(true)
    finish(lut)
    await new Promise((r) => setTimeout(r, 0))
    expect(slide.colorLut).toBeNull()
  })

  it('the default source reads a manifest profile by Range from its file', async () => {
    const asked: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${(init?.headers as Record<string, string>)?.Range}`)
      return new Response(new Uint8Array([9, 9, 9, 9]), { status: 206 })
    }) as typeof fetch
    const source = new ManifestRangeSource({
      ...makeManifest(1),
      iccProfile: { url: 'https://host/f.dcm', offset: 100, length: 4 },
    })
    source.bind({
      resolveUrl: (u) => u,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent() {},
      updateRangeEvent() {},
    })
    expect([...((await source.fetchIccProfile()) ?? [])]).toEqual([9, 9, 9, 9])
    expect(asked).toEqual(['https://host/f.dcm bytes=100-103'])
  })

  it('a failed profile is logged and leaves identity', async () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    NVSlide.registerIccTransform(async () => {
      throw new Error('bad profile')
    })
    const slide = NVSlide.fromSource(withProfile(profile))
    await new Promise((r) => setTimeout(r, 0))
    expect(slide.displayColorLut).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
