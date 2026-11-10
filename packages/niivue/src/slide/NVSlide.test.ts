import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { log } from '@/logger'
import type {
  NVChannel,
  NVSlideChannelInfo,
  NVSlideColorLut,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideRangeEvent,
  NVSlideTileManifest,
  NVSlideTileSamples,
  SlideTileDecoder,
  SlideTileSource,
} from './NVSlide'
import {
  assertSingleSlidePlane,
  compositeSamples,
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
    const last = slide.requestVisibleTiles({
      widthCss: TILE_W,
      heightCss: TILE_H,
    })
    expect(slide.lastVisibleTiles).toBe(last) // the view reads it, not a second walk
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

describe('NVSlide auto level selection', () => {
  // Default target 0.75 device pixels per tile pixel; makePyramid downsamples 1, 2, 4.
  const level = (scale: number, devicePixelRatio?: number) => {
    const slide = NVSlide.fromSource(new CountingSource(makePyramid()))
    slide.viewport.scale = scale
    const screen = { widthCss: 32, heightCss: 16, devicePixelRatio }
    const picked = slide.selectLevel(screen)?.index
    expect(slide.visibleTiles(screen).level?.index).toBe(picked)
    slide.dispose()
    return picked
  }

  it('picks the level by device pixels (#638)', () => {
    expect(level(0.5)).toBe(1) // no devicePixelRatio: CSS pixels, as before
    for (const dpr of [1, 1.5, 2, 3]) {
      expect(level(0.75 / dpr, dpr)).toBe(0)
      expect(level(0.74 / dpr, dpr)).toBe(1)
    }
  })
})

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

  it('takes tags of one each as given when the frame count is absent', () => {
    expect(() => assertSingleSlidePlane(dicom(undefined, 1, 1))).not.toThrow()
    expect(() => assertSingleSlidePlane(dicom(undefined, 2, 1))).toThrow()
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

  it('loads only the centred tiles that fit when no level does', async () => {
    // One level of 16 tiles (2048 B); the 525 B budget keeps 4.
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const manifest = makePyramid()
    manifest.levels = manifest.levels.slice(0, 1)
    const source = new CountingSource(manifest)
    const slide = NVSlide.fromSource(source, { maxCacheBytes: 700 })
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const visible = slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.capped).toBe(true)
    expect(visible.tiles.map(({ tile }) => [tile.x, tile.y])).toEqual([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ])
    expect(String(warn.mock.calls[0]?.[0])).toContain('only the 4 tiles')
    await waitFor(() => slide.stats.completed === 4)
    // Settled: later frames request nothing more.
    for (let i = 0; i < 3; i++) slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(slide.stats.requested).toBe(4)
    warn.mockRestore()
    slide.dispose()
  })

  it('caps a one-row view at the tile limit (#666)', () => {
    // 16 tiles in one row; the 525 B budget keeps 4 (the centred 6..9).
    const slide = NVSlide.fromSource(new CountingSource(makeManifest(16)), {
      maxCacheBytes: 700,
    })
    slide.setViewport({ centerX: 8 * TILE_W, centerY: TILE_H / 2, scale: 1 })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const visible = slide.visibleTiles({
      widthCss: 16 * TILE_W,
      heightCss: TILE_H,
    })
    expect(visible.capped).toBe(true)
    expect(visible.tiles.map(({ tile }) => tile.x)).toEqual([6, 7, 8, 9])
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

// Bun has no ImageData/createImageBitmap: a stand-in bitmap carries its pixels.
type FakeBitmap = {
  width: number
  height: number
  data: Uint8ClampedArray
  closed: boolean
  close(): void
}
const g = globalThis as Record<string, unknown>

/** Install stand-in ImageData/createImageBitmap for the enclosing describe. */
function useFakeBitmaps(): void {
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
  })
}

const pixel = (slide: NVSlide, key: string, offset = 0) =>
  (slide.cachedTileBitmap(key) as unknown as FakeBitmap | null)?.data[offset]
const rgbaAt = (slide: NVSlide, key: string) =>
  Array.from(
    (slide.cachedTileBitmap(key) as unknown as FakeBitmap).data.subarray(0, 4),
  )

describe('NVSlide monochrome window', () => {
  useFakeBitmaps()
  afterEach(() => {
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

  it('coalesces a burst of windows into one pass over the cached tiles', async () => {
    const slide = monoSlide(500)
    await loadLevel(slide, 2)
    await loadLevel(slide, 1)
    const tiles = [...slide.manifest.levels].reduce(
      (n, level) =>
        n + (level.index <= 2 && level.index >= 1 ? level.tiles.length : 0),
      0,
    )
    const create = globalThis.createImageBitmap
    let calls = 0
    globalThis.createImageBitmap = ((...args: Parameters<typeof create>) => {
      calls++
      return create(...args)
    }) as typeof createImageBitmap
    try {
      for (let hi = 600; hi <= 1000; hi += 100) slide.setWindow(0, hi)
      await waitFor(
        () => pixel(slide, 'L2/0/0') === 128 && pixel(slide, 'L1/1/1') === 128,
      )
      // One tile may be in flight for the first window when the burst lands.
      expect(calls).toBeLessThanOrEqual(tiles + 1)
    } finally {
      globalThis.createImageBitmap = create
    }
    slide.dispose()
  })

  it('renders setWindow and setChannel(0) identically, as windowSamples did', async () => {
    const viaWindow = monoSlide(500)
    const viaChannel = monoSlide(500)
    expect(viaChannel.channels).toEqual([
      {
        name: 'gray',
        colormap: 'gray',
        calMin: Number.NaN,
        calMax: Number.NaN,
        visible: true,
      },
    ])
    await loadLevel(viaWindow, 2)
    await loadLevel(viaChannel, 2)
    viaWindow.setWindow(0, 1000)
    viaChannel.setChannel(0, { calMin: 0, calMax: 1000 })
    await waitFor(
      () =>
        pixel(viaWindow, 'L2/0/0') === 128 &&
        pixel(viaChannel, 'L2/0/0') === 128,
    )
    const bits = (s: NVSlide) =>
      Array.from((s.cachedTileBitmap('L2/0/0') as unknown as FakeBitmap).data)
    const expected = Array.from(
      windowSamples(
        new Uint16Array(TILE_W * TILE_H).fill(500),
        { calMin: 0, calMax: 1000 },
        false,
      ),
    )
    expect(bits(viaWindow)).toEqual(expected)
    expect(bits(viaChannel)).toEqual(expected)
    expect(viaChannel.window).toEqual({ calMin: 0, calMax: 1000 })
    // A non-grey colormap takes the composite path: red carries the same grey level.
    viaChannel.setChannel(0, { colormap: 'red' })
    await waitFor(() => pixel(viaChannel, 'L2/0/0', 1) === 0)
    expect(rgbaAt(viaChannel, 'L2/0/0')).toEqual([128, 0, 0, 255])
    viaWindow.dispose()
    viaChannel.dispose()
  })

  it('inverts MONOCHROME1 through a colormap too; window shows a one-sided bound', async () => {
    const slide = monoSlide(500, 'MONOCHROME1')
    slide.setChannel(0, { colormap: 'red' })
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([224, 0, 0, 255]) // 255 - round(500 * 255 / 4095)
    slide.setChannel(0, { calMin: 100 })
    expect(slide.window).toEqual({ calMin: 100, calMax: Number.NaN })
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

describe('compositeSamples', () => {
  it('matches windowSamples for one grey channel', () => {
    const samples = new Uint16Array([0, 100, 200, 300, 4095])
    const w = { calMin: 100, calMax: 300 }
    const grey = windowSamples(samples, w, false)
    const lut = new Uint8Array(65536 * 4)
    const table = windowSamples(
      Uint16Array.from({ length: 65536 }, (_, v) => v),
      w,
      false,
    )
    lut.set(table)
    expect(
      Array.from(compositeSamples(samples, 5, [{ plane: 0, lut }], false)),
    ).toEqual(Array.from(grey))
  })
})

// Serves planar samples: every pixel of channel c holds values[c]. `pad` adds
// right/bottom padding of 0s, `gate` holds each fetch, `planes` overrides the count.
class PlanarSource implements SlideTileSource {
  readonly requested: number[][] = []
  pad = 0
  gate: Promise<void> = Promise.resolve()
  planes?: number
  constructor(
    readonly manifest: NVSlideManifest,
    readonly values: number[],
  ) {}
  bind(): void {}
  fetchTileBytes(): Promise<Uint8Array> {
    throw new Error('a sample source is not asked for bytes')
  }
  async fetchTileSamples(
    _level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
  ): Promise<NVSlideTileSamples> {
    this.requested.push([...channels])
    await this.gate
    const width = tile.width + this.pad
    const height = tile.height + this.pad
    const samples = new Uint8Array(width * height * channels.length)
    channels.forEach((c, p) => {
      for (let y = 0; y < tile.height; y++) {
        const row = (p * height + y) * width
        samples.fill(this.values[c] as number, row, row + tile.width)
      }
    })
    return {
      samples,
      width,
      height,
      bitsStored: 8,
      planes: this.planes ?? channels.length,
    }
  }
}

describe('NVSlide channels', () => {
  useFakeBitmaps()

  // Grey 100, red 200, blue 30: max gives (200, 100, 100), additive (255, 100, 130).
  function planarSlide(
    channelInfo?: NVSlideChannelInfo[],
    values = [100, 200, 30],
    options: { maxCacheBytes?: number } = {},
  ): { slide: NVSlide; source: PlanarSource } {
    const manifest = makePyramid()
    manifest.channelInfo = channelInfo
    for (const level of manifest.levels) level.bitsStored = 8
    const source = new PlanarSource(manifest, values)
    const slide = NVSlide.fromSource(source, options)
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    return { slide, source }
  }
  const threeChannels = (blueActive = true): NVSlideChannelInfo[] => [
    { name: 'grey', rgb: [255, 255, 255], active: true },
    { name: 'red', rgb: [255, 0, 0], active: true },
    { name: 'blue', rgb: [0, 0, 255], active: blueActive },
  ]

  it('builds channels from channelInfo: colormap, usable window, active', () => {
    const { slide } = planarSlide([
      {
        name: 'a',
        rgb: [255, 0, 0],
        window: { calMin: 5, calMax: 90 },
        active: true,
      },
      { name: 'b', window: { calMin: 9, calMax: 9 }, active: false },
    ])
    expect(slide.channels).toEqual([
      { name: 'a', colormap: 'red', calMin: 5, calMax: 90, visible: true },
      {
        name: 'b',
        colormap: 'violet', // the palette's second entry: no stated colour
        calMin: Number.NaN,
        calMax: Number.NaN,
        visible: false,
      },
    ])
    expect(slide.channelBlend).toBe('max')
    slide.dispose()
  })

  it('composites planar channels by max, and by sum once additive', async () => {
    const { slide } = planarSlide(threeChannels())
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([200, 100, 100, 255])
    // Three uint8 planes per tile, beside the RGBA bitmap.
    expect(slide.cacheBytes).toBe(TILE_W * TILE_H * (4 + 3))
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, 'L2/0/0', 2) === 130)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([255, 100, 130, 255])
    slide.dispose()
  })

  it('neither fetches nor shows a hidden channel; showing it refetches', async () => {
    const { slide, source } = planarSlide(threeChannels(false))
    await loadLevel(slide, 2)
    expect(source.requested).toEqual([[0, 1]])
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([200, 100, 100, 255])
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, 'L2/0/0') === 255)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([255, 100, 100, 255])
    slide.setChannel(2, { visible: true })
    expect(slide.cachedTileBitmap('L2/0/0')).toBeNull()
    await loadLevel(slide, 2)
    expect(source.requested.at(-1)).toEqual([0, 1, 2])
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([255, 100, 130, 255])
    slide.dispose()
  })

  it('returns channel copies: a readback cannot change the slide', () => {
    const { slide } = planarSlide(threeChannels())
    let changes = 0
    slide.addEventListener('change', () => changes++)
    const ch = slide.channels[0] as NVChannel
    ch.calMin = 9
    ch.calMax = 1
    expect(slide.window).toBeNull()
    expect(changes).toBe(0)
    slide.dispose()
  })

  it('keeps only the known channel fields', () => {
    const { slide } = planarSlide(threeChannels())
    slide.setChannel(0, { extra: 7 } as Partial<NVChannel>)
    expect(Object.keys(slide.channels[0] ?? {}).sort()).toEqual([
      'calMax',
      'calMin',
      'colormap',
      'name',
      'visible',
    ])
    slide.dispose()
  })

  it('keeps a field set to undefined', () => {
    const { slide } = planarSlide(threeChannels())
    slide.setChannel(0, {
      name: undefined,
      colormap: undefined,
      visible: undefined,
    })
    expect(slide.channels[0]).toMatchObject({
      name: 'grey',
      colormap: 'gray',
      visible: true,
    })
    slide.dispose()
  })

  it('does not fetch a tile with every channel hidden', async () => {
    const { slide, source } = planarSlide([{ name: 'grey', active: false }])
    await loadLevel(slide, 2)
    expect(source.requested).toEqual([])
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([0, 0, 0, 255])
    slide.dispose()
  })

  it('refetches a tile whose channel was shown while it loaded', async () => {
    const { slide, source } = planarSlide(threeChannels(false))
    let release = () => {}
    source.gate = new Promise((resolve) => {
      release = resolve
    })
    slide.setLevelChoice(2)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    slide.setChannel(2, { visible: true })
    slide.setChannel(2, { visible: false })
    slide.setChannel(2, { visible: true })
    source.gate = Promise.resolve()
    release()
    await waitFor(() => slide.stats.completed === 1)
    expect(source.requested).toEqual([
      [0, 1],
      [0, 1, 2],
    ])
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([200, 100, 100, 255])
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, 'L2/0/0', 2) === 130)
    slide.dispose()
  })

  it('re-primes the coarsest level when a shown channel drops it', async () => {
    const { slide, source } = planarSlide(threeChannels(false))
    const coarsest = slide.manifest.levels[2]
    const tile = coarsest?.tiles[0]
    if (!coarsest || !tile) throw new Error('no coarsest tile')
    slide.requestTile(coarsest, tile) // as setSlidePlane primes it
    await waitFor(() => slide.stats.completed === 1)
    slide.setChannel(2, { visible: true })
    await waitFor(() => slide.stats.completed === 2)
    expect(source.requested.at(-1)).toEqual([0, 1, 2])
    expect(slide.cachedTileBitmap('L2/0/0')).not.toBeNull()
    slide.dispose()
  })

  it('crops every plane of a padded sample frame', async () => {
    const { slide, source } = planarSlide(threeChannels())
    source.pad = 3
    slide.setChannelBlend('additive')
    await loadLevel(slide, 2)
    const bitmap = slide.cachedTileBitmap('L2/0/0') as unknown as FakeBitmap
    expect([bitmap.width, bitmap.height]).toEqual([TILE_W, TILE_H])
    const last = (TILE_W * TILE_H - 1) * 4
    expect(Array.from(bitmap.data.subarray(last, last + 4))).toEqual([
      255, 100, 130, 255,
    ])
    slide.dispose()
  })

  it('fails a tile whose plane count differs from the channels asked for', async () => {
    const { slide, source } = planarSlide(threeChannels())
    source.planes = 2
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    slide.setLevelChoice(2)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    await waitFor(() => slide.stats.failures === 1)
    expect(String(errors.mock.calls[0]?.[1])).toContain(
      'Expected 3 sample planes, received 2',
    )
    expect(slide.cachedTileBitmap('L2/0/0')).toBeNull()
    errors.mockRestore()
    slide.dispose()
  })

  it('keeps a one-sided window from inverting; undefined bounds are the default', async () => {
    const { slide } = planarSlide(threeChannels())
    slide.setChannel(1, { calMin: 5000 }) // above every u8 sample: black, not inverted
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([100, 100, 100, 255])
    slide.setChannel(1, { calMin: undefined })
    expect(slide.channels[1]?.calMin).toBeNaN()
    slide.dispose()
  })

  it('re-renders cached tiles on a channel change without refetching', async () => {
    const { slide, source } = planarSlide(threeChannels())
    await loadLevel(slide, 2)
    const changes: number[] = []
    slide.addEventListener('change', () => changes.push(1))
    slide.setChannel(1, { calMin: 0, calMax: 100 }) // red saturates
    slide.setChannel(0, { visible: false })
    await waitFor(() => pixel(slide, 'L2/0/0', 1) === 0)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([255, 0, 30, 255])
    expect(source.requested).toHaveLength(1)
    expect(changes.length).toBeGreaterThan(0)
    slide.dispose()
  })

  it('keeps an RGB slide additive', async () => {
    const { slide } = planarSlide(undefined, [200, 100, 50])
    expect(slide.channels.map((c) => c.colormap)).toEqual([
      'red',
      'green',
      'blue',
    ])
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([200, 100, 50, 255])
    slide.setChannelBlend('max')
    expect(slide.channelBlend).toBe('additive')
    // Green as grey overlaps red: additive sums them.
    slide.setChannel(1, { colormap: 'gray' })
    await waitFor(() => pixel(slide, 'L2/0/0') === 255)
    expect(rgbaAt(slide, 'L2/0/0')).toEqual([255, 100, 150, 255])
    slide.dispose()
  })

  it('counts every fetched plane against the cache budget', () => {
    // 75% of 3000 = 2250 B: L0's 16 tiles x 32 px x (4 + 3) B = 3584 B do not
    // fit (without the planes, 2048 B would); L1's 4 tiles do.
    const { slide } = planarSlide(threeChannels(), undefined, {
      maxCacheBytes: 3000,
    })
    slide.setLevelChoice(0)
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    expect(slide.visibleTiles(WHOLE_SLIDE_SCREEN).level?.index).toBe(1)
    warn.mockRestore()
    slide.dispose()
  })

  it('rejects bad channel updates and planes other than {0, 0}', () => {
    const { slide } = planarSlide(threeChannels())
    expect(() => slide.setChannel(3, { visible: true })).toThrow(RangeError)
    expect(() => slide.setChannel(0, { calMin: 9, calMax: 9 })).toThrow(
      RangeError,
    )
    expect(() => slide.setChannel(0, { colormap: 'no-such-map' })).toThrow(
      RangeError,
    )
    expect(slide.plane).toEqual({ z: 0, t: 0 })
    slide.setPlane({ z: 0, t: 0 })
    expect(() => slide.setPlane({ z: 1, t: 0 })).toThrow(RangeError)
    expect(() => slide.setPlane({ z: 0, t: 2 })).toThrow(RangeError)
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

describe('NVSlide.fromManifestUrl', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("reports the server's refusal reason with the status", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: 'Unsupported DICOM-WSI transfer syntax 1.2.840.10008.1.2.4.70',
        },
        { status: 415 },
      )) as unknown as typeof fetch
    await expect(NVSlide.fromManifestUrl('/m.json')).rejects.toThrow(
      'Slide manifest HTTP 415: Unsupported DICOM-WSI transfer syntax 1.2.840.10008.1.2.4.70',
    )
  })

  it('keeps the bare status for a non-JSON error body', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 502 })) as unknown as typeof fetch
    await expect(NVSlide.fromManifestUrl('/m.json')).rejects.toThrow(
      /^Slide manifest HTTP 502$/,
    )
  })

  it('does not wait on a JSON error body that never finishes, and aborts it', async () => {
    const stalled = new ReadableStream({ start() {} })
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal
      return new Response(stalled, {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await expect(NVSlide.fromManifestUrl('/m.json')).rejects.toThrow(
      /^Slide manifest HTTP 502$/,
    )
    expect(signal?.aborted).toBe(true)
  })

  it('reads the reason for an uppercase JSON media type', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'unsupported syntax' }), {
        status: 415,
        headers: { 'content-type': 'Application/JSON; Charset=UTF-8' },
      })) as unknown as typeof fetch
    await expect(NVSlide.fromManifestUrl('/m.json')).rejects.toThrow(
      'Slide manifest HTTP 415: unsupported syntax',
    )
  })
})

describe('raw-gray cache budget', () => {
  it('counts retained samples without a photometric tag', () => {
    const manifest = makePyramid()
    for (const l of manifest.levels) {
      l.codec = 'raw-gray'
      l.bitsStored = 16
    }
    // 75% of 3500 = 2625 B: L0's 16 tiles x 32 px x (4 RGBA + 2 sample) bytes
    // = 3072 B do not fit, L1's 4 tiles (768 B) do.
    const slide = NVSlide.fromSource(new CountingSource(manifest), {
      maxCacheBytes: 3500,
    })
    expect(slide.visibleTiles(WHOLE_SLIDE_SCREEN).level?.index).toBe(1)
    slide.dispose()
  })
})

describe('raw-gray tile decoder', () => {
  const decode = NVSlide.tileDecoder('raw-gray') as SlideTileDecoder
  const level = (bitsStored?: number) =>
    ({ ...makePyramid().levels[0], bitsStored }) as NVSlideLevelManifest

  it('reads 16-bit samples, also from an odd byte offset', async () => {
    const src = new Uint8Array(9)
    src.set(new Uint8Array(new Uint16Array([1, 2, 3, 65535]).buffer), 1)
    const out = await decode(src.subarray(1), {
      width: 2,
      height: 2,
      level: level(12),
    })
    expect(out).toMatchObject({ width: 2, height: 2, bitsStored: 12 })
    expect(Array.from((out as NVSlideTileSamples).samples)).toEqual([
      1, 2, 3, 65535,
    ])
  })

  it('reads 8-bit samples and rejects a wrong length', async () => {
    const out = await decode(new Uint8Array([7, 8]), {
      width: 2,
      height: 1,
      level: level(8),
    })
    expect((out as NVSlideTileSamples).samples).toBeInstanceOf(Uint8Array)
    await expect(
      decode(new Uint8Array(3), { width: 2, height: 1, level: level(16) }),
    ).rejects.toThrow('Expected 2x1 16-bit samples')
  })

  it('rejects bitsStored above 16, which the default window cannot show', async () => {
    await expect(
      decode(new Uint8Array(4), { width: 2, height: 1, level: level(32) }),
    ).rejects.toThrow('raw-gray supports bitsStored up to 16, received 32')
  })
})
