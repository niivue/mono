import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test'
import NVViewGL from '@/gl/NVViewGL'
import { SlideRenderer } from '@/gl/slide'
import { log } from '@/logger'
import NVViewGPU from '@/wgpu/NVViewGPU'
import type {
  NVChannel,
  NVSlideChannelInfo,
  NVSlideColor,
  NVSlideColorLut,
  NVSlideLevelChangeDetail,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideRangeEvent,
  NVSlideRequestClass,
  NVSlideRequestOwner,
  NVSlideSampleArray,
  NVSlideTileErrorDetail,
  NVSlideTileManifest,
  NVSlideTileSamples,
  SlideTileDecoder,
} from './NVSlide'
import { NVSlide } from './NVSlide'
import { toStored, toValue } from './slideChannels'
import {
  type FuseTile,
  fusePlan,
  fuseSamples,
  rawFormat,
  SlideBudgetRegistration,
} from './slideFuse'
import { tileCapacity } from './slideLod'
import type { SlidePlaneState } from './slidePlane'
import {
  assertSingleSlidePlane,
  ManifestRangeSource,
  type SlidePlaneCapable,
  type SlideSourceHost,
  type SlideTileSource,
} from './slideSource'

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

/** The tile key of level `i`, column `x`, row `y`. */
const k = (slide: NVSlide, i: number, x: number, y: number) =>
  slide.tileKey(slide.manifest.levels[i] as NVSlideLevelManifest, { x, y })

/** A new owner of class `kind` wanting every present tile of `level`. */
function wantAll(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  kind: NVSlideRequestClass = 'plane3d',
): NVSlideRequestOwner {
  const owner = slide.createRequestOwner(kind)
  owner.want(level.tiles.flatMap((tile) => (tile ? [{ level, tile }] : [])))
  return owner
}

describe('NVSlide tile loading', () => {
  it('caps concurrent fetch+decode at maxConcurrentLoads and completes all tiles', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const tileCount = 30
    const source = new CountingSource(makeManifest(tileCount))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    wantAll(slide, level)
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
      wantAll(slide, level)
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
    wantAll(slide, level)
    await waitFor(() => slide.stats.completed === tileCount)
    // Encoded payload is 16 bytes/tile; decoded accounting must dominate.
    expect(slide.cacheBytes).toBe(tileCount * DECODED_TILE_BYTES)
    expect(slide.stats.decodedBytes).toBe(tileCount * DECODED_TILE_BYTES)
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
    wantAll(slide, level0)
    await waitFor(() => slide.stats.completed + slide.stats.failures === 10)
    expect(slide.stats.completed).toBe(7)
    expect(slide.stats.failures).toBe(3)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })
})

describe('NVSlide background colour', () => {
  it('defaults to the manifest colour; an option wins', () => {
    const manifest: NVSlideManifest = {
      ...makeManifest(1),
      backgroundColor: [1, 1, 1, 1],
    }
    const white: NVSlideColor = [1, 1, 1, 1]
    expect(new NVSlide(manifest).backgroundColor).toEqual(white)
    expect(
      new NVSlide(manifest, { backgroundColor: [0, 0, 0, 1] }).backgroundColor,
    ).toEqual([0, 0, 0, 1])
    expect(new NVSlide(makeManifest(1)).backgroundColor).not.toEqual(white)
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

// Pins a level and draws until it (and its coverage) is resident: the view
// starts its loads synchronously, so nothing pending means all settled.
async function loadLevel(slide: NVSlide, levelIndex: number): Promise<void> {
  const level = slide.manifest.levels[levelIndex]
  if (!level) throw new Error(`no level ${levelIndex}`)
  slide.setLevelChoice(levelIndex)
  slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
  await waitFor(
    () =>
      slide.pendingCount === 0 &&
      level.tiles.every((t) => !t || slide.cachedTile(slide.tileKey(level, t))),
  )
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

  it('holds a level within the 1.1 hysteresis band, both ways', () => {
    const slide = NVSlide.fromSource(new CountingSource(makePyramid()))
    const at = (scale: number) => {
      slide.viewport.scale = scale
      return slide.visibleTiles(WHOLE_SLIDE_SCREEN).level?.index
    }
    expect(at(0.75)).toBe(0)
    expect(level(0.7)).toBe(1) // fresh: below the target
    expect(at(0.7)).toBe(0) // held: within 0.75 / 1.1
    expect(at(0.68)).toBe(1) // past the band
    expect(at(0.8)).toBe(1) // held: under 0.75 * 1.1
    expect(at(0.83)).toBe(0)
    slide.dispose()
  })
})

describe('NVSlide coarse fallback layer', () => {
  it('offers cached coarser tiles, coarsest first, while the target level loads', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new CountingSource(makePyramid())
    const slide = NVSlide.fromSource(source)
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    await loadLevel(slide, 2)
    // Three of L1's four tiles resident, so L1 alone does not cover the view.
    const l1 = slide.manifest.levels[1] as NVSlideLevelManifest
    const three = slide.createRequestOwner('plane3d')
    three.want(
      l1.tiles
        .slice(0, 3)
        .map((tile) => ({ level: l1, tile: tile as NVSlideTileManifest })),
    )
    await waitFor(() => slide.stats.completed === 4)

    // Switch to the finest level: none of its 16 tiles are cached yet, so the
    // renderer must be handed the coarse tiles standing in for them.
    slide.setLevelChoice(0)
    const visible = slide.visibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.level?.index).toBe(0)
    expect(visible.tiles.length).toBe(16)
    // L2's single tile, then L1's three: painting in array order lets each
    // finer level overpaint the one below it.
    expect(visible.fallback.map((item) => item.level.index)).toEqual([
      2, 1, 1, 1,
    ])
    // A complete L1 hides L2: the walk stops at it.
    three.want(
      l1.tiles.map((tile) => ({
        level: l1,
        tile: tile as NVSlideTileManifest,
      })),
    )
    await waitFor(() => slide.stats.completed === 5)
    expect(
      slide.visibleTiles(WHOLE_SLIDE_SCREEN).fallback.map((t) => t.level.index),
    ).toEqual([1, 1, 1, 1])

    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
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
    const visible = slide.visibleTiles(WHOLE_SLIDE_SCREEN)
    expect(visible.fallback.map((item) => item.level.index)).toEqual([2])
    expect(slide.stats.requested).toBe(requestedBefore)
    // Drawing wants the 16 target tiles and L1's 4 as coverage, nothing for
    // the fallback layer.
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(slide.stats.requested - requestedBefore).toBe(20)
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
    wantAll(slide, level)
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
    // All 30 tiles in view: the 8 nearest the centre (11..18) in flight, 22 queued ...
    slide.requestVisibleTiles({ widthCss: TILE_W * 30, heightCss: TILE_H })
    await waitFor(() => source.signals.length === 8)
    // ... then only tile 0 stays visible: all 8 in-flight loads are abandoned
    // on the wire and the 21 other queued ones are dropped.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    const last = slide.requestVisibleTiles({
      widthCss: TILE_W,
      heightCss: TILE_H,
    })
    expect(slide.lastVisibleTiles).toBe(last) // the view reads it, not a second walk
    expect(source.signals.filter((s) => s.aborted).length).toBe(8)
    await waitFor(() => source.signals.length === 9) // tile 0 starts
    source.releaseAll()
    await waitFor(() => slide.stats.completed === 1)
    expect(slide.pendingCount).toBe(0)
    expect(slide.stats.aborted).toBe(29)
    expect(slide.stats.failures).toBe(0)
    // An aborted tile is not poisoned: bringing tile 14 back into view refetches.
    const before = source.signals.length
    slide.setViewport({ centerX: TILE_W * 14.5, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    await waitFor(() => source.signals.length === before + 1)
    source.releaseAll()
    await waitFor(() => slide.stats.completed === 2)
    expect(source.signals.length).toBe(before + 1)
    expect(slide.cachedTile(k(slide, 0, 14, 0))).not.toBeNull()
    slide.dispose()
  })
  it("keeps another owner's QUEUED load through a view pass that drops it", async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const source = new AbortableSource(makeManifest(2))
    // One load slot, so the owner's second tile stays QUEUED behind the first.
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    wantAll(slide, level)
    await waitFor(() => source.signals.length === 1)
    // The view wants only tile 0 and then nothing: the queued tile 1 is still
    // its owner's, so it must not be dropped.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    slide.visible = false
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

  it('keeps a view-started load that another owner also wants, until it releases', async () => {
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
    // ... then another owner wants tile 1 (already in flight: no second fetch) ...
    const claimed = level.tiles[1]
    if (!claimed) throw new Error('missing tile')
    const owner = slide.createRequestOwner('plane3d')
    owner.want([{ level, tile: claimed }])
    // ... and the viewport moves away from everything but tile 0.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    // Only tiles 2 and 3 abort; tile 0 (visible) and tile 1 (wanted) survive.
    const aborted = () => source.signals.filter((s) => s.aborted).length
    expect(aborted()).toBe(2)
    // The last owner's release aborts the shared load.
    owner.release()
    expect(aborted()).toBe(3)
    source.releaseAll()
    await waitFor(() => slide.pendingCount === 0)
    expect(slide.stats.completed).toBe(1)
    expect(slide.stats.aborted).toBe(3)
    expect(source.signals).toHaveLength(4)
    slide.dispose()
  })

  it('discards bytes a source resolves after its signal was aborted', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    // A source that ignores the signal entirely (third-party, pre-signal API).
    const source = new CountingSource(makeManifest(2))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 2 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    wantAll(slide, level)
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
    slide.createRequestOwner('plane3d').want([{ level, tile }])
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

const NO_HOST: SlideSourceHost = {
  resolveUrl: (url) => url,
  addWireBytes() {},
  rangeHit() {},
  rangeFallback() {},
  channelInfoChanged() {},
  pushRangeEvent() {},
  updateRangeEvent() {},
}

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
      ...NO_HOST,
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
    ).rejects.toMatchObject({ name: 'AbortError' })
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
    source.bind(NO_HOST)
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

  it('accepts one of each that tags or the frame count prove', () => {
    for (const m of [
      dicom(1, 1, 1),
      dicom(undefined, 1, 1),
      dicom(1),
      makeManifest(2), // formats without these dimensions
    ])
      expect(() => assertSingleSlidePlane(m)).not.toThrow()
    expect(() => assertSingleSlidePlane(dicom(undefined, 2, 1))).toThrow()
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
    wantAll(slide, slide.manifest.levels[0] ?? level)
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
    expect(visible.limitedBy).toBe('cache')
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

  it('charges a grey JPEG kept as a bitmap 4 bytes a pixel', () => {
    // Without OffscreenCanvas a MONOCHROME JPEG stays RGBA: 16 tiles of 128 B,
    // so the 525 B budget keeps 4 (as 1 B/px samples it would keep all 16).
    expect(typeof OffscreenCanvas).toBe('undefined')
    const manifest = makeManifest(16)
    const level = manifest.levels[0] as NVSlideLevelManifest
    level.photometric = 'MONOCHROME2'
    const slide = NVSlide.fromSource(new CountingSource(manifest), {
      maxCacheBytes: 700,
    })
    slide.setViewport({ centerX: 8 * TILE_W, centerY: TILE_H / 2, scale: 1 })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const visible = slide.visibleTiles({
      widthCss: 16 * TILE_W,
      heightCss: TILE_H,
    })
    expect(visible.tiles).toHaveLength(4)
    warn.mockRestore()
    slide.dispose()
  })

  it('caps scalar tiles by the tile texture budget too', () => {
    // 32 u8 tiles of 1024 px: 32 MiB of samples fit the CPU cache, but each is
    // a 4 MiB RGBA8 texture in view; 75% of the 96 MiB texture budget holds 17.
    const tiles = Array.from({ length: 32 }, (_, x) => ({
      x,
      y: 0,
      width: 1024,
      height: 1024,
    }))
    const manifest: NVSlideManifest = {
      id: 'big',
      name: 'big',
      width: 32 * 1024,
      height: 1024,
      tileSize: 1024,
      dtype: 'uint8',
      channels: 'gray',
      levels: [
        {
          index: 0,
          width: 32 * 1024,
          height: 1024,
          downsample: 1,
          tileWidth: 1024,
          tileHeight: 1024,
          columns: 32,
          rows: 1,
          codec: 'raw-gray',
          bitsStored: 8,
          tiles,
        },
      ],
    }
    const slide = NVSlide.fromSource(new CountingSource(manifest), {
      maxCacheBytes: 1024 * 1024 * 1024,
    })
    slide.setViewport({ centerX: 16 * 1024, centerY: 512, scale: 1 })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const visible = slide.visibleTiles({
      widthCss: 32 * 1024,
      heightCss: 1024,
    })
    expect(visible.capped).toBe(true)
    expect(visible.tiles).toHaveLength(17)
    expect(visible.limitedBy).toBe('texture')
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
    slide.createRequestOwner('plane3d').want([{ level, tile }])
    await waitFor(() => slide.stats.completed === 1)
    expect(crops).toEqual([[0, 0, 3, 2]])
    expect(closedPadded).toBe(true)
    expect(slide.stats.cacheBytes).toBe(3 * 2 * 4) // the crop, not the 8 x 4 frame
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
    const owner = slide.createRequestOwner('view')
    const render = () => owner.want([{ level, tile }])
    render()
    await waitFor(() => slide.stats.failures === 1)
    for (let i = 0; i < 5; i++) render()
    expect(slide.stats.requested).toBe(1)
    now += 1001 // past the 1 s backoff
    render()
    await waitFor(() => slide.stats.failures === 2)
    now += 1001 // the second wait is 2 s
    render()
    expect(slide.stats.requested).toBe(2)
    clock.mockRestore()
    error.mockRestore()
    slide.dispose()
  })
})

describe('NVSlide retry timers', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('retry a burst of failed view tiles on one change event; a readout does not retry', async () => {
    jest.useFakeTimers()
    const source = new GraySource(grayManifest(2))
    source.failing = true
    const slide = NVSlide.fromSource(source)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const screen = { widthCss: 2 * T, heightCss: T }
    slide.setViewport({ centerX: T, centerY: T / 2, scale: 1 })
    slide.requestVisibleTiles(screen) // (0, 0) and (1, 0)
    const readout = await slide.loadSampleAt(T + 1, T + 1) // (1, 1)
    expect(readout[0]?.missing).toBe('uncached')
    expect(slide.stats.failures).toBe(3)
    source.failing = false
    let changes = 0
    slide.addEventListener('change', () => changes++)
    // Past the 1 s backoff and its 250 ms retry tick.
    jest.advanceTimersByTime(1300)
    expect(changes).toBe(1)
    slide.requestVisibleTiles(screen) // the host redraws on 'change'
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const fetchesOf = (i: number) =>
      source.fetched.filter((f) => f.tile === level.tiles[i]).length
    expect([0, 1, 3].map(fetchesOf)).toEqual([2, 2, 1])
    await new Promise((resolve) => slide.addEventListener('idle', resolve))
    expect(slide.stats.completed).toBe(2)
    error.mockRestore()
    slide.dispose()
  })
})

describe('slide level grid cap', () => {
  it('refuses a grid over 2^22 tiles before allocating it', () => {
    const manifest = makeManifest(1)
    const level = manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    Object.assign(level, { columns: 2049, rows: 2048, tiles: [], sparse: true })
    expect(() => new NVSlide(manifest)).toThrow('over the 4194304')
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

// What a renderer draws for a cached tile: its bitmap, or its samples fused
// through the slide's channels (the CPU reference of the GPU fuse).
function drawn(slide: NVSlide, key: string): Uint8ClampedArray | undefined {
  const entry = slide.cachedTile(key)
  if (entry?.bitmap) return (entry.bitmap as unknown as FakeBitmap).data
  const s = entry?.samples
  if (!s) return undefined
  const plan = fusePlan(slide.channels, slide.channelBlend, entry as FuseTile)
  return fuseSamples(s.samples, s.width * s.height, plan)
}
const pixel = (slide: NVSlide, key: string, offset = 0) =>
  drawn(slide, key)?.[offset]
const rgbaAt = (slide: NVSlide, key: string) =>
  Array.from(drawn(slide, key)?.subarray(0, 4) ?? [])

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
    ].map((t, i) =>
      pixel(slide, k(slide, i < 16 ? 0 : 1, t?.x ?? 0, t?.y ?? 0)),
    )
    expect(new Set(values)).toEqual(new Set([255]))
    // 8x4 uint16 samples per tile, no RGBA bitmap: L0 and L1 (each fits one
    // round of load slots, so no coverage is fetched).
    expect(slide.cacheBytes).toBe(20 * (TILE_W * TILE_H * 2))
    expect(slide.cachedTile(k(slide, 0, 0, 0))?.bitmap).toBeUndefined()
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
    const s = slide.cachedTile(k(slide, 2, 0, 0))?.samples
    expect([s?.width, s?.height]).toEqual([TILE_W, TILE_H])
    const rgba = drawn(slide, k(slide, 2, 0, 0)) ?? []
    expect(new Set(rgba.filter((_, i) => i % 4 === 0))).toEqual(new Set([255]))
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
    expect(pixel(slide, k(slide, 2, 0, 0))).toBe(195) // 255 - 60, the default 0..255 window
    slide.setChannel(0, { calMin: 0, calMax: 120 })
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0)) === 127) // 255 - round(60 * 255 / 120)
    slide.dispose()
  })

  it('re-windows cached tiles and windows later arrivals the same way', async () => {
    const slide = monoSlide(500)
    await loadLevel(slide, 2)
    const entry = slide.cachedTile(k(slide, 2, 0, 0))
    expect(pixel(slide, k(slide, 2, 0, 0))).toBe(31) // round(500 * 255 / 4095)
    const gen = slide.displayGeneration
    slide.setChannel(0, { calMin: 0, calMax: 1000 })
    // The renderers re-fuse the kept samples: same entry, a new generation.
    expect(slide.displayGeneration).toBe(gen + 1)
    expect(slide.cachedTile(k(slide, 2, 0, 0))).toBe(entry)
    expect(pixel(slide, k(slide, 2, 0, 0))).toBe(128)
    await loadLevel(slide, 1)
    expect(pixel(slide, k(slide, 1, 1, 1))).toBe(128)
    expect(slide.channels[0]).toMatchObject({ calMin: 0, calMax: 1000 })
    slide.dispose()
  })

  it('changes channels without any CPU re-render', async () => {
    const slide = monoSlide(500)
    await loadLevel(slide, 2)
    const create = globalThis.createImageBitmap
    let calls = 0
    globalThis.createImageBitmap = ((...args: Parameters<typeof create>) => {
      calls++
      return create(...args)
    }) as typeof createImageBitmap
    let changes = 0
    slide.addEventListener('change', () => changes++)
    try {
      for (let hi = 600; hi <= 1000; hi += 100)
        slide.setChannel(0, { calMin: 0, calMax: hi })
      expect(calls).toBe(0)
      expect(changes).toBe(5)
      expect(pixel(slide, k(slide, 2, 0, 0))).toBe(128)
    } finally {
      globalThis.createImageBitmap = create
    }
    slide.dispose()
  })

  it('renders setChannel(0) through the window, grey or coloured', async () => {
    const slide = monoSlide(500)
    expect(slide.channels).toEqual([
      {
        name: 'gray',
        colormap: 'gray',
        calMin: Number.NaN,
        calMax: Number.NaN,
        visible: true,
      },
    ])
    await loadLevel(slide, 2)
    slide.setChannel(0, { calMin: 0, calMax: 1000 })
    expect(Array.from(drawn(slide, k(slide, 2, 0, 0)) ?? [])).toEqual(
      Array.from({ length: TILE_W * TILE_H }, () => [
        128, 128, 128, 255,
      ]).flat(),
    )
    // A non-grey colormap takes the composite path: red carries the same grey level.
    slide.setChannel(0, { colormap: 'red' })
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0), 1) === 0)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([128, 0, 0, 255])
    slide.dispose()
  })

  it('inverts MONOCHROME1 through a colormap too; keeps a one-sided bound', async () => {
    const slide = monoSlide(500, 'MONOCHROME1')
    slide.setChannel(0, { colormap: 'red' })
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([224, 0, 0, 255]) // 255 - round(500 * 255 / 4095)
    slide.setChannel(0, { calMin: 100 })
    expect(slide.channels[0]).toMatchObject({
      calMin: 100,
      calMax: Number.NaN,
    })
    slide.dispose()
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

  it('falls back from an unknown channelInfo colormap', () => {
    const { slide } = planarSlide([
      { name: 'a', rgb: [255, 0, 0], colormap: 'no-such-map', active: true },
    ])
    expect(slide.channels[0]?.colormap).toBe('red')
    slide.setChannel(0, { calMin: 1 }) // threw "Unknown colormap"
    slide.dispose()
  })

  it('composites planar channels by max, and by sum once additive', async () => {
    const { slide } = planarSlide(threeChannels())
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([200, 100, 100, 255])
    // Three uint8 planes per tile, no RGBA bitmap.
    expect(slide.cacheBytes).toBe(TILE_W * TILE_H * 3)
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0), 2) === 130)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([255, 100, 130, 255])
    slide.dispose()
  })

  it('neither fetches nor shows a hidden channel; showing it refetches', async () => {
    const { slide, source } = planarSlide(threeChannels(false))
    await loadLevel(slide, 2)
    expect(source.requested).toEqual([[0, 1]])
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([200, 100, 100, 255])
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0)) === 255)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([255, 100, 100, 255])
    slide.setChannel(2, { visible: true })
    // ENG-09: the tile stays drawable without the new channel until the next
    // draw refetches it in place.
    expect(slide.cachedTile(k(slide, 2, 0, 0))?.channels).toEqual([0, 1])
    expect(source.requested).toHaveLength(1)
    await loadLevel(slide, 2)
    expect(source.requested.at(-1)).toEqual([0, 1, 2])
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([255, 100, 130, 255])
    slide.dispose()
  })

  it('returns channel copies: a readback cannot change the slide', () => {
    const { slide } = planarSlide(threeChannels())
    let changes = 0
    slide.addEventListener('change', () => changes++)
    const ch = slide.channels[0] as NVChannel
    ch.calMin = 9
    ch.calMax = 1
    expect(slide.channels[0]).toMatchObject({
      calMin: Number.NaN,
      calMax: Number.NaN,
    })
    expect(changes).toBe(0)
    slide.dispose()
  })

  it('keeps only the known channel fields, and a field set to undefined', () => {
    const { slide } = planarSlide(threeChannels())
    slide.setChannel(0, { extra: 7 } as Partial<NVChannel>)
    slide.setChannel(0, {
      name: undefined,
      colormap: undefined,
      visible: undefined,
    })
    expect(slide.channels[0]).toEqual({
      name: 'grey',
      colormap: 'gray',
      calMin: Number.NaN,
      calMax: Number.NaN,
      visible: true,
    })
    slide.dispose()
  })

  it('does not fetch a tile with every channel hidden', async () => {
    const { slide, source } = planarSlide([{ name: 'grey', active: false }])
    await loadLevel(slide, 2)
    expect(source.requested).toEqual([])
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([0, 0, 0, 255])
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
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([200, 100, 100, 255])
    slide.setChannelBlend('additive')
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0), 2) === 130)
    slide.dispose()
  })

  it('refreshes a stale tile in place on show; hiding issues no reads (ENG-09)', async () => {
    const { slide, source } = planarSlide(threeChannels(false))
    const coarsest = slide.manifest.levels[2] as NVSlideLevelManifest
    const owner = wantAll(slide, coarsest)
    const key = k(slide, 2, 0, 0)
    await waitFor(() => slide.stats.completed === 1)
    const old = slide.cachedTile(key)
    let release = () => {}
    source.gate = new Promise((resolve) => {
      release = resolve
    })
    slide.setChannel(2, { visible: true })
    // Showing drops nothing and reads nothing by itself ...
    expect(slide.cachedTile(key)).toBe(old)
    expect(source.requested).toHaveLength(1)
    // ... the owner's next want refetches, the old tile drawing meanwhile.
    owner.want([
      { level: coarsest, tile: coarsest.tiles[0] as NVSlideTileManifest },
    ])
    expect(source.requested.at(-1)).toEqual([0, 1, 2])
    expect(slide.cachedTile(key)).toBe(old)
    // A stale tile is no load avoided: a second owner joins the refetch.
    const second = wantAll(slide, coarsest)
    expect(slide.stats.cacheHits).toBe(0)
    expect(source.requested).toHaveLength(2)
    second.release()
    release()
    await waitFor(() => slide.stats.completed === 2)
    expect(slide.cachedTile(key)?.channels).toEqual([0, 1, 2])
    // Hiding keeps the fuller tile: no read on any later want or draw.
    slide.setChannel(2, { visible: false })
    owner.want([
      { level: coarsest, tile: coarsest.tiles[0] as NVSlideTileManifest },
    ])
    slide.setLevelChoice(2)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(source.requested).toHaveLength(2)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })

  // Engine bug: channels >= 32 never marked a tile stale.
  it('refreshes in place on showing channel 35 of 40; re-showing it reads nothing', async () => {
    const info = Array.from({ length: 40 }, (_, c) => ({
      name: `c${c}`,
      active: c === 0,
    }))
    const { slide, source } = planarSlide(
      info,
      info.map((_, c) => c),
    )
    const coarsest = slide.manifest.levels[2] as NVSlideLevelManifest
    const tiles = [
      { level: coarsest, tile: coarsest.tiles[0] as NVSlideTileManifest },
    ]
    const owner = slide.createRequestOwner('plane3d')
    owner.want(tiles)
    await waitFor(() => slide.stats.completed === 1)
    slide.setChannel(35, { visible: true })
    owner.want(tiles)
    expect(source.requested.at(-1)).toEqual([0, 35])
    await waitFor(() => slide.stats.completed === 2)
    expect(slide.cachedTile(k(slide, 2, 0, 0))?.channels).toEqual([0, 35])
    slide.setChannel(35, { visible: false })
    owner.want(tiles)
    slide.setChannel(35, { visible: true })
    owner.want(tiles)
    expect(source.requested).toHaveLength(2)
    slide.dispose()
  })

  // Revised Q10: a source raises a tile error (e.g. a label ID over 2^24).
  it("a sample source's tile error reaches 'tileerror' with its key", async () => {
    const { slide, source } = planarSlide(threeChannels())
    source.fetchTileSamples = () =>
      Promise.reject(new RangeError('label ID 16777217 is over 2^24'))
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const details: NVSlideTileErrorDetail[] = []
    slide.addEventListener('tileerror', (e) =>
      details.push((e as CustomEvent<NVSlideTileErrorDetail>).detail),
    )
    const coarsest = slide.manifest.levels[2] as NVSlideLevelManifest
    wantAll(slide, coarsest)
    await waitFor(() => details.length === 1)
    expect(details[0]?.key).toBe(k(slide, 2, 0, 0))
    expect(String(details[0]?.error)).toContain('over 2^24')
    error.mockRestore()
    slide.dispose()
  })

  it('crops every plane of a padded sample frame', async () => {
    const { slide, source } = planarSlide(threeChannels())
    source.pad = 3
    slide.setChannelBlend('additive')
    await loadLevel(slide, 2)
    const s = slide.cachedTile(k(slide, 2, 0, 0))?.samples
    expect([s?.width, s?.height]).toEqual([TILE_W, TILE_H])
    const last = (TILE_W * TILE_H - 1) * 4
    expect(
      Array.from(
        drawn(slide, k(slide, 2, 0, 0))?.subarray(last, last + 4) ?? [],
      ),
    ).toEqual([255, 100, 130, 255])
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
    expect(slide.cachedTile(k(slide, 2, 0, 0))).toBeNull()
    errors.mockRestore()
    slide.dispose()
  })

  it('keeps a one-sided window from inverting; undefined bounds are the default', async () => {
    const { slide } = planarSlide(threeChannels())
    slide.setChannel(1, { calMin: 5000 }) // above every u8 sample: black, not inverted
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([100, 100, 100, 255])
    slide.setChannel(1, { calMin: undefined })
    expect(slide.channels[1]?.calMin).toBeNaN()
    slide.dispose()
  })
  it('composites a thumbnail of a level, the same bitmap until it changes', async () => {
    const put: number[][] = []
    const drawn: number[][] = []
    const closed: number[] = []
    const sizes: number[][] = []
    let made = 0
    g.OffscreenCanvas = class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        sizes.push([width, height])
      }
      getContext() {
        return {
          canvas: this,
          putImageData: (img: { data: Uint8ClampedArray }) =>
            put.push(Array.from(img.data.subarray(0, 4))),
          drawImage: (...args: unknown[]) =>
            drawn.push(args.slice(5) as number[]),
        }
      }
      transferToImageBitmap() {
        const id = ++made
        return { id, close: () => closed.push(id) }
      }
    }
    const { slide, source } = planarSlide(threeChannels())
    const [finest, , coarsest] = slide.manifest.levels
    expect(slide.thumbnailBitmap()).toBeNull() // nothing resident: requested
    await waitFor(() => slide.stats.completed === 1)
    expect(source.requested).toHaveLength(1)
    const first = slide.thumbnailBitmap()
    expect(first).toMatchObject({ id: 1 })
    expect(put).toEqual([[200, 100, 100, 255]])
    expect(drawn).toEqual([[0, 0, 8, 4]])
    expect(slide.thumbnailBitmap(coarsest)).toBe(first)
    slide.setChannelBlend('additive')
    expect(slide.thumbnailBitmap()).toMatchObject({ id: 2 })
    expect(put.at(-1)).toEqual([255, 100, 130, 255])
    expect(closed).toEqual([1]) // replaced
    // Scaled into maxPx: 32 x 16 at 16 px is 16 x 8, tiles 4 x 2 on whole pixels.
    await loadLevel(slide, 0)
    drawn.length = 0
    sizes.length = 0
    const small = slide.thumbnailBitmap(finest, 16)
    expect(sizes[0]).toEqual([16, 8])
    expect(drawn).toHaveLength(16)
    expect(drawn[5]).toEqual([4, 2, 4, 2])
    // Two slots: the minimap's and the wand's levels do not evict each other.
    expect(slide.thumbnailBitmap()).toMatchObject({ id: 2 })
    expect(slide.thumbnailBitmap(finest, 16)).toBe(small)
    slide.dispose()
    expect(closed.sort()).toEqual([1, 2, 3])
  })

  it('keeps an RGB slide additive', async () => {
    const { slide } = planarSlide(undefined, [200, 100, 50])
    expect(slide.channels.map((c) => c.colormap)).toEqual([
      'red',
      'green',
      'blue',
    ])
    await loadLevel(slide, 2)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([200, 100, 50, 255])
    slide.setChannelBlend('max')
    expect(slide.channelBlend).toBe('additive')
    // Green as grey overlaps red: additive sums them.
    slide.setChannel(1, { colormap: 'gray' })
    await waitFor(() => pixel(slide, k(slide, 2, 0, 0)) === 255)
    expect(rgbaAt(slide, k(slide, 2, 0, 0))).toEqual([255, 100, 150, 255])
    slide.dispose()
  })

  it('counts every fetched plane against the cache budget', () => {
    // 75% of 1500 = 1125 B: L0's 16 tiles x 32 px x 3 planes = 1536 B do not
    // fit (one plane, 512 B, would); L1's 4 tiles do.
    const { slide } = planarSlide(threeChannels(), undefined, {
      maxCacheBytes: 1500,
    })
    slide.setLevelChoice(0)
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    expect(slide.visibleTiles(WHOLE_SLIDE_SCREEN).level?.index).toBe(1)
    warn.mockRestore()
    slide.dispose()
  })

  it('rejects bad channel updates and, on a fixed source, planes other than {0, 0} (P6)', async () => {
    const { slide } = planarSlide(threeChannels())
    expect(() => slide.setChannel(3, { visible: true })).toThrow(RangeError)
    expect(() => slide.setChannel(0, { calMin: 9, calMax: 9 })).toThrow(
      RangeError,
    )
    // A non-finite bound means the default (stored range), not an error.
    slide.setChannel(0, { calMin: Number.NaN, calMax: 1 })
    expect(slide.channels[0]?.calMin).toBeNaN()
    expect(() => slide.setChannel(0, { colormap: 'no-such-map' })).toThrow(
      RangeError,
    )
    expect(slide.planes).toEqual({ z: 1, t: 1 })
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    expect(await slide.setPlaneIndex({ z: 0, t: 0 })).toBe(true)
    await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
      RangeError,
    )
    await expect(slide.setPlaneIndex({ z: 0, t: 2 })).rejects.toThrow(
      RangeError,
    )
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
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
    // The 6 present tiles; no coverage for a target within one round of slots.
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

  it('skips an sRGB profile, and a monochrome slide (its window is the display mapping)', async () => {
    let calls = 0
    NVSlide.registerIccTransform(async () => {
      calls++
      return lut
    })
    const source = withProfile(profile)
    NVSlide.fromSource({
      ...source,
      manifest: {
        ...source.manifest,
        iccProfile: { url: 'p', colorSpace: 'SRGB' },
      },
    })
    NVSlide.fromSource({
      ...source,
      manifest: {
        ...source.manifest,
        levels: source.manifest.levels.map((l) => ({
          ...l,
          photometric: 'MONOCHROME2',
        })),
      },
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
  })

  it('refuses a table that is not size^3 RGBA8 bytes, or too large', async () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    for (const bad of [
      { size: 2, data: new Uint8Array(24) }, // RGB, not RGBA
      { size: 2, data: new Float32Array(32) as unknown as Uint8Array },
      { size: 130, data: new Uint8Array(130 ** 3 * 4) },
    ]) {
      NVSlide.registerIccTransform(async () => bad)
      const slide = NVSlide.fromSource(withProfile(profile))
      await new Promise((r) => setTimeout(r, 0))
      expect(slide.colorLut).toBeNull()
    }
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('a manifest profile with only one of offset and length is refused', async () => {
    const source = new ManifestRangeSource({
      ...makeManifest(1),
      iccProfile: { url: 'https://host/f.dcm', offset: 100 },
    })
    source.bind(NO_HOST)
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
    source.bind(NO_HOST)
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
    jest.useRealTimers()
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
    jest.useFakeTimers()
    const stalled = new ReadableStream({ start() {} })
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal
      return new Response(stalled, {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const failed = NVSlide.fromManifestUrl('/m.json').catch((e: Error) => e)
    // Run the 1 s body timer once the reply has started it.
    for (let i = 0; i < 100 && !signal?.aborted; i++) {
      await Promise.resolve()
      jest.advanceTimersByTime(1000)
    }
    expect(signal?.aborted).toBe(true)
    expect(String(await failed)).toBe('Error: Slide manifest HTTP 502')
  })

  it('refuses a manifest past 64 MiB, Content-Length or not', async () => {
    let pulled = 0
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (++pulled > 100) c.close()
            else c.enqueue(new Uint8Array(1 << 20))
          },
        }),
      )) as unknown as typeof fetch
    await expect(NVSlide.fromManifestUrl('/m.json')).rejects.toThrow(
      `Reply over ${64 * 1024 * 1024} bytes`,
    )
    expect(pulled).toBeLessThanOrEqual(66)
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
    // 75% of 1200 = 900 B: L0's 16 tiles x 32 px x 2 sample bytes = 1024 B
    // do not fit (at 8 bits, 512 B would), L1's 4 tiles (256 B) do.
    const slide = NVSlide.fromSource(new CountingSource(manifest), {
      maxCacheBytes: 1200,
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

// 30 x 14 at level 0 (edge tiles 6 x 2), downsampled 2 and 4. Sample planes
// encode where they came from: level * 10000 + channel * 1000 + gy * 32 + gx.
function codedManifest(): NVSlideManifest {
  const levels = [1, 2, 4].map((downsample, index): NVSlideLevelManifest => {
    const width = Math.ceil(30 / downsample)
    const height = Math.ceil(14 / downsample)
    const columns = Math.ceil(width / TILE_W)
    const rows = Math.ceil(height / TILE_H)
    const tiles: NVSlideTileManifest[] = []
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++)
        tiles.push({
          x,
          y,
          width: Math.min(TILE_W, width - x * TILE_W),
          height: Math.min(TILE_H, height - y * TILE_H),
        })
    return {
      index,
      width,
      height,
      downsample,
      tileWidth: TILE_W,
      tileHeight: TILE_H,
      columns,
      rows,
      bitsStored: 16,
      tiles,
    }
  })
  return {
    id: 'coded',
    name: 'coded',
    width: 30,
    height: 14,
    tileSize: TILE_W,
    dtype: 'uint16',
    channels: 'planar',
    levels,
  }
}

class CodedSource implements SlideTileSource {
  readonly requested: number[][] = []
  gate: Promise<void> = Promise.resolve()
  constant?: number[]
  fail = false
  constructor(readonly manifest: NVSlideManifest) {}
  bind(): void {}
  fetchTileBytes(): Promise<Uint8Array> {
    throw new Error('a sample source is not asked for bytes')
  }
  async fetchTileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
  ): Promise<NVSlideTileSamples> {
    this.requested.push([...channels])
    await this.gate
    if (this.fail) throw new Error('tile fetch failed')
    const { width, height } = tile
    const samples = new Uint16Array(width * height * channels.length)
    channels.forEach((c, p) => {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          samples[(p * height + y) * width + x] =
            this.constant?.[c] ??
            level.index * 10000 +
              c * 1000 +
              (tile.y * TILE_H + y) * 32 +
              tile.x * TILE_W +
              x
    })
    return { samples, width, height, bitsStored: 16, planes: channels.length }
  }
}

describe('NVSlide.sampleAt', () => {
  useFakeBitmaps()
  const channelInfo = (
    blueActive = false,
    storedToValue?: NVSlideChannelInfo['storedToValue'],
  ): NVSlideChannelInfo[] =>
    ['grey', 'red', 'blue'].map((name, c) => ({
      name,
      active: c < 2 || blueActive,
      storedToValue,
    }))
  function codedSlide(
    info = channelInfo(),
    options: { maxCacheBytes?: number; maxConcurrentLoads?: number } = {},
    manifest = codedManifest(),
  ) {
    manifest.channelInfo = info
    const source = new CodedSource(manifest)
    return { slide: NVSlide.fromSource(source, options), source }
  }
  const sample = (
    channel: number,
    name: string,
    value: number,
    level: number,
  ) => ({ channel, name, value, stored: value, level, exact: level === 0 })
  const missing = (s: ReturnType<NVSlide['sampleAt']>) =>
    s.map((r) => r.missing)

  it('reads each visible channel at level 0, exact; never fetches a hidden one', async () => {
    const { slide, source } = codedSlide()
    // The bottom-right edge tile (6 x 2), pixel (5, 1).
    expect(await slide.loadSampleAt(29.5, 13)).toEqual([
      sample(0, 'grey', 13 * 32 + 29, 0),
      sample(1, 'red', 1000 + 13 * 32 + 29, 0),
      {
        channel: 2,
        name: 'blue',
        value: null,
        stored: null,
        level: 0,
        exact: false,
        missing: 'hidden',
      },
    ])
    expect(source.requested).toEqual([[0, 1]])
    slide.dispose()
  })

  it('reads a channel from its held plane, not its index', async () => {
    const info = channelInfo(true)
    ;(info[1] as NVSlideChannelInfo).active = false
    const { slide, source } = codedSlide(info)
    const [, red, blue] = await slide.loadSampleAt(2, 1)
    expect(source.requested).toEqual([[0, 2]])
    expect(red?.missing).toBe('hidden')
    expect(blue).toEqual(sample(2, 'blue', 2000 + 32 + 2, 0))
    slide.dispose()
  })

  it('reports a channel hidden after its tile loaded as hidden', async () => {
    const { slide } = codedSlide()
    await slide.loadSampleAt(2, 1)
    slide.setChannel(1, { visible: false })
    expect(missing(slide.sampleAt(2, 1))).toEqual([
      undefined,
      'hidden',
      'hidden',
    ])
    slide.dispose()
  })

  it('reports an inactive channel hidden before its tile is cached', () => {
    const { slide } = codedSlide()
    expect(slide.sampleAt(2, 1)[2]).toMatchObject({
      missing: 'hidden',
      level: 0,
    })
    expect(missing(slide.sampleAt(2, 1, { level: 0 }))).toEqual([
      'uncached',
      'uncached',
      'hidden',
    ])
    slide.dispose()
  })

  it('loadSampleAt after dispose fetches nothing', async () => {
    const { slide, source } = codedSlide()
    slide.dispose()
    expect(missing(await slide.loadSampleAt(2, 1))[0]).toBe('uncached')
    expect(source.requested).toEqual([])
    expect(slide.stats.cacheBytes).toBe(0)
  })

  it('serves the finest resident level; opts.level pins one', async () => {
    const { slide } = codedSlide()
    // Level 2 is 8 x 4: (floor(29 * 8 / 30), floor(13 * 4 / 14)) = (7, 3).
    const coarse = await slide.loadSampleAt(29, 13, { level: 2 })
    expect(coarse[0]).toEqual(sample(0, 'grey', 20000 + 3 * 32 + 7, 2))
    expect(slide.sampleAt(29, 13)[1]).toEqual(
      sample(1, 'red', 21000 + 3 * 32 + 7, 2),
    )
    expect(missing(slide.sampleAt(29, 13, { level: 0 }))).toEqual([
      'uncached',
      'uncached',
      'hidden',
    ])
    // Level 1, tile (1, 0), pixel (0, 2): global (8, 2).
    expect((await slide.loadSampleAt(17, 5, { level: 1 }))[0]).toEqual(
      sample(0, 'grey', 10000 + 2 * 32 + 8, 1),
    )
    await slide.loadSampleAt(29, 13)
    expect(slide.sampleAt(29, 13)[0]?.level).toBe(0)
    expect(slide.sampleAt(29, 13, { level: 2 })[0]?.level).toBe(2)
    slide.dispose()
  })

  it('tells outside, uncached and hole apart', async () => {
    const { slide } = codedSlide()
    for (const [x, y] of [
      [-1, 0],
      [30, 0],
      [0, 14],
      [Number.NaN, 0],
    ])
      expect(missing(slide.sampleAt(x as number, y as number))).toEqual(
        Array(3).fill('outside'),
      )
    expect(slide.sampleAt(0, 0)[0]).toEqual({
      channel: 0,
      name: 'grey',
      value: null,
      stored: null,
      level: null,
      exact: false,
      missing: 'uncached',
    })
    slide.dispose()

    const manifest = codedManifest()
    for (const level of manifest.levels) level.tiles[0] = null
    const holed = codedSlide(channelInfo(), {}, manifest)
    expect(missing(holed.slide.sampleAt(0, 0))).toEqual(Array(3).fill('hole'))
    expect(missing(await holed.slide.loadSampleAt(0, 0))).toEqual(
      Array(3).fill('hole'),
    )
    expect(holed.source.requested).toEqual([])
    holed.slide.dispose()
    // A hole at level 0 only: a coarser tile could serve it.
    const base = codedManifest()
    ;(base.levels[0] as NVSlideLevelManifest).tiles[0] = null
    const l0 = codedSlide(channelInfo(), {}, base).slide
    expect(missing(l0.sampleAt(0, 0))[0]).toBe('uncached')
    expect(missing(l0.sampleAt(0, 0, { level: 0 }))[0]).toBe('hole')
    l0.dispose()
  })

  it('peeks: LRU order and cacheHits are unchanged', async () => {
    // A full level-0 sample tile keeps no bitmap: two u16 8 x 4 planes = 128 bytes.
    const { slide } = codedSlide(channelInfo(), { maxCacheBytes: 256 })
    await slide.loadSampleAt(0, 0)
    await slide.loadSampleAt(8, 0)
    const hits = slide.stats.cacheHits
    expect(slide.sampleAt(0, 0)[0]?.level).toBe(0) // the oldest entry
    await slide.loadSampleAt(16, 0) // evicts the oldest
    expect(missing(slide.sampleAt(0, 0))[0]).toBe('uncached')
    expect(slide.sampleAt(8, 0)[0]?.level).toBe(0)
    expect(slide.stats.cacheHits).toBe(hits)
    slide.dispose()
  })

  it('maps quantized samples through storedToValue, clipped at the ends', async () => {
    const { slide, source } = codedSlide(
      channelInfo(true, { scale: 0.5, offset: -10 }),
    )
    source.constant = [0, 65535, 300]
    const [grey, red, blue] = await slide.loadSampleAt(3, 3)
    expect(grey).toMatchObject({ stored: 0, value: -10, exact: false })
    expect(grey?.clipped).toBe(true)
    expect(red).toMatchObject({ value: 65535 * 0.5 - 10, clipped: true })
    expect(blue).toEqual({
      channel: 2,
      name: 'blue',
      value: 140,
      stored: 300,
      level: 0,
      exact: false,
    })
    slide.dispose()
  })

  it('reads u8 samples', async () => {
    const manifest = makePyramid()
    manifest.channelInfo = channelInfo(true)
    const slide = NVSlide.fromSource(new PlanarSource(manifest, [100, 200, 30]))
    const values = (await slide.loadSampleAt(5, 5)).map((s) => s.stored)
    expect(values).toEqual([100, 200, 30])
    slide.dispose()
  })

  it('reports a MONOCHROME1 sample as stored, not inverted', async () => {
    const jls = NVSlide.tileDecoder('image/jls')
    NVSlide.registerTileDecoder('image/jls', async () => ({
      samples: new Uint16Array(TILE_W * TILE_H).fill(500),
      width: TILE_W,
      height: TILE_H,
      bitsStored: 16,
    }))
    const manifest = makePyramid()
    for (const level of manifest.levels)
      Object.assign(level, {
        codec: 'image/jls',
        photometric: 'MONOCHROME1',
        bitsStored: 12,
      })
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    expect(await slide.loadSampleAt(1, 1)).toEqual([sample(0, 'gray', 500, 0)])
    if (jls) NVSlide.registerTileDecoder('image/jls', jls)
    slide.dispose()
  })

  it('loadSampleAt survives a pan, honours signal and resolves a failure uncached', async () => {
    const { slide, source } = codedSlide()
    let release = () => {}
    source.gate = new Promise((resolve) => {
      release = resolve
    })
    const panned = slide.loadSampleAt(0, 0)
    // The viewport moves to another level and corner: the readout's own
    // owner keeps its load.
    slide.setViewport({ centerX: 28, centerY: 12, scale: 4 })
    slide.setLevelChoice(0)
    slide.requestVisibleTiles({ widthCss: 8, heightCss: 4 })
    const stop = new AbortController()
    const aborted = slide.loadSampleAt(8, 4, { signal: stop.signal })
    stop.abort(new Error('stop'))
    expect(missing(await aborted)[0]).toBe('uncached')
    release()
    expect((await panned)[0]?.level).toBe(0)
    // The aborted readout's load was nobody else's: cancelled, never cached.
    await waitFor(() => slide.stats.aborted === 1)
    expect(missing(slide.sampleAt(8, 4, { level: 0 }))[0]).toBe('uncached')

    source.fail = true
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    expect(missing(await slide.loadSampleAt(16, 8))[0]).toBe('uncached')
    // Held back after the failure: settles at once, without a new fetch.
    const fetches = source.requested.length
    expect(missing(await slide.loadSampleAt(16, 8))[0]).toBe('uncached')
    expect(source.requested.length).toBe(fetches)
    quiet.mockRestore()
    slide.dispose()
  })

  it('reads an RGB bitmap tile back one pixel', async () => {
    // A stand-in canvas that honours drawImage's source x, y.
    g.OffscreenCanvas = class {
      getContext() {
        let px = new Uint8ClampedArray(4)
        return {
          drawImage: (b: FakeBitmap, sx: number, sy: number) => {
            const o = (sy * b.width + sx) * 4
            px = b.data.slice(o, o + 4)
          },
          getImageData: () => ({ data: px }),
        }
      }
    }
    const rgbSlide = () => {
      const manifest = makePyramid()
      for (const level of manifest.levels) level.codec = 'raw-rgba'
      return NVSlide.fromSource({
        manifest,
        bind() {},
        fetchTileBytes: async (_level, tile) => {
          const bytes = new Uint8Array(tile.width * tile.height * 4)
          for (let i = 0; i < tile.width * tile.height; i++)
            bytes.set([i, 100 + i, 50, 255], i * 4)
          return bytes
        },
      })
    }
    const slide = rgbSlide()
    // Tile (0, 0), pixel (3, 2): i = 19.
    expect(await slide.loadSampleAt(3, 2)).toEqual([
      sample(0, 'red', 19, 0),
      sample(1, 'green', 119, 0),
      sample(2, 'blue', 50, 0),
    ])
    expect(slide.sampleAt(4, 2)[0]?.stored).toBe(20) // the reused context
    slide.dispose()
    g.OffscreenCanvas = undefined
    const bare = rgbSlide()
    expect(missing(await bare.loadSampleAt(3, 2))[0]).toBe('uncached')
    bare.dispose()
  })

  it('dispose settles a readout queued behind an unrelated load', async () => {
    const { slide, source } = codedSlide(channelInfo(), {
      maxConcurrentLoads: 1,
    })
    source.gate = new Promise(() => {}) // tile 0 never lands
    const first = slide.loadSampleAt(0, 0)
    const queued = slide.loadSampleAt(8, 0)
    const removed = spyOn(slide, 'removeEventListener')
    slide.dispose()
    expect(missing(await queued)[0]).toBe('uncached')
    expect(missing(await first)[0]).toBe('uncached')
    expect(source.requested.length).toBe(1) // tile 1 was never fetched
    expect(removed.mock.calls.filter(([t]) => t === 'change').length).toBe(2)
  })
})

describe('NVSlide events', () => {
  it("emits 'tileerror' with the tile and its backoff", async () => {
    const manifest = makeManifest(1)
    const level = manifest.levels[0] as NVSlideLevelManifest
    const tile = level.tiles[0] as NVSlideTileManifest
    tile.frame = -1 // CountingSource rejects it
    const slide = NVSlide.fromSource(new CountingSource(manifest))
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const details: NVSlideTileErrorDetail[] = []
    slide.addEventListener('tileerror', (e) =>
      details.push((e as CustomEvent<NVSlideTileErrorDetail>).detail),
    )
    slide.createRequestOwner('view').want([{ level, tile }])
    await waitFor(() => details.length === 1)
    const [detail] = details
    expect(detail?.key).toBe(k(slide, 0, 0, 0))
    expect(detail?.level).toBe(slide.manifest.levels[0] as NVSlideLevelManifest)
    expect(detail?.tile).toBe(tile)
    expect(String(detail?.error)).toContain('tile fetch failed')
    expect(detail?.retryInMs).toBe(1000)
    error.mockRestore()
    slide.dispose()
  })

  it("emits 'levelchange' from requestVisibleTiles once per level, with its limit", () => {
    const slide = NVSlide.fromSource(new CountingSource(makePyramid()), {
      maxCacheBytes: 700, // L0's 16 tiles do not fit; L1's 4 do
    })
    slide.setViewport({ centerX: 16, centerY: 8, scale: 1 })
    const details: NVSlideLevelChangeDetail[] = []
    slide.addEventListener('levelchange', (e) =>
      details.push((e as CustomEvent<NVSlideLevelChangeDetail>).detail),
    )
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    slide.setLevelChoice(2)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    slide.visibleTiles(WHOLE_SLIDE_SCREEN) // a HUD read is no draw
    slide.setLevelChoice(0)
    slide.requestVisibleTiles(WHOLE_SLIDE_SCREEN)
    expect(
      details.map((d) => [d.level.index, d.requestedLevel?.index, d.limitedBy]),
    ).toEqual([
      [2, undefined, undefined],
      [1, 0, 'cache'],
    ])
    warn.mockRestore()
    slide.dispose()
  })

  it("emits 'idle' once nothing is queued or loading", async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const slide = NVSlide.fromSource(new CountingSource(makeManifest(3)), {
      maxConcurrentLoads: 1,
    })
    const pendingAtIdle: number[] = []
    slide.addEventListener('idle', () => pendingAtIdle.push(slide.pendingCount))
    wantAll(slide, slide.manifest.levels[0] as NVSlideLevelManifest)
    await waitFor(() => slide.stats.completed === 3)
    expect(pendingAtIdle).toEqual([0])
    slide.dispose()
  })

  it("accessors emit 'change' when the value changes", () => {
    const slide = NVSlide.fromSource(new CountingSource(makeManifest(1)))
    let changes = 0
    slide.addEventListener('change', () => changes++)
    slide.opacity = 0.5
    slide.opacity = 0.5
    slide.visible = false
    slide.levelChoice = 0
    slide.targetScreenPixelsPerTilePixel = 2
    slide.showTileGrid = true
    slide.backgroundColor = [1, 0, 0, 1]
    slide.placeholderColor = [0, 1, 0, 1]
    slide.gridColor = [0, 0, 1, 1]
    expect(changes).toBe(8)
    expect([slide.opacity, slide.visible, slide.levelChoice]).toEqual([
      0.5,
      false,
      0,
    ])
    slide.dispose()
  })
})

describe('NVSlide cacheHits', () => {
  it('counts loads avoided, not draws', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const slide = NVSlide.fromSource(new CountingSource(makeManifest(1)))
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const loader = wantAll(slide, level)
    await waitFor(() => slide.stats.completed === 1)
    expect(slide.stats.cacheHits).toBe(0)
    // Draws and readouts of the resident tile avoid no load.
    for (let i = 0; i < 5; i++) slide.cachedTile(k(slide, 0, 0, 0))
    slide.sampleAt(1, 1)
    loader.want(
      level.tiles.map((tile) => ({ level, tile: tile as NVSlideTileManifest })),
    )
    expect(slide.stats.cacheHits).toBe(0)
    // A view newly wanting it avoids one load, however often it draws.
    slide.setViewport({ centerX: TILE_W / 2, centerY: TILE_H / 2, scale: 1 })
    for (let i = 0; i < 3; i++)
      slide.requestVisibleTiles({ widthCss: TILE_W, heightCss: TILE_H })
    expect(slide.stats.cacheHits).toBe(1)
    wantAll(slide, level)
    expect(slide.stats.cacheHits).toBe(2)
    expect(slide.stats.requested).toBe(1)
    slide.dispose()
  })
})

describe('NVSlide readout of a stale tile', () => {
  useFakeBitmaps()

  // Engine bug: loadSampleAt's settle() takes "key in cache" for done, so a
  // stale tile (fetched before a channel was shown) resolves at once and its
  // release cancels the refetch it just started.
  it('loadSampleAt refetches a tile lacking a now-visible channel', async () => {
    const manifest = makePyramid()
    manifest.channelInfo = ['grey', 'red', 'blue'].map((name, c) => ({
      name,
      active: c < 2,
    }))
    for (const level of manifest.levels) level.bitsStored = 8
    const source = new PlanarSource(manifest, [100, 200, 30])
    const slide = NVSlide.fromSource(source)
    expect((await slide.loadSampleAt(1, 1)).map((s) => s.stored)).toEqual([
      100,
      200,
      null,
    ])
    slide.setChannel(2, { visible: true })
    expect((await slide.loadSampleAt(1, 1)).map((s) => s.stored)).toEqual([
      100, 200, 30,
    ])
    expect(slide.stats.aborted).toBe(0)
    slide.dispose()
  })
})

const T = 8
const MiB = 1024 * 1024

/** A raw-gray u16 pyramid of `n` x `n` tiles of T px. */
function grayManifest(
  n = 2,
  level: Partial<NVSlideLevelManifest> = {},
  channelInfo?: NVSlideChannelInfo[],
): NVSlideManifest {
  const tiles = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) tiles.push({ x, y, width: T, height: T })
  return {
    id: 'g',
    name: 'g',
    width: T * n,
    height: T * n,
    tileSize: T,
    dtype: 'uint16',
    channels: 'gray',
    levels: [
      {
        index: 0,
        width: T * n,
        height: T * n,
        downsample: 1,
        columns: n,
        rows: n,
        codec: 'raw-gray',
        bitsStored: 16,
        tiles,
        ...level,
      },
    ],
    ...(channelInfo ? { channelInfo } : {}),
  }
}

type Fetch = {
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  signal?: AbortSignal
}

/**
 * A raw-gray source of focal planes: samples are `value`, else 10 * (z + 1).
 * Records each fetch; `gated` holds fetches until `release` (ignoring the
 * signal, as a source that cannot stop a read); `failing` rejects them.
 */
class GraySource implements SlideTileSource, SlidePlaneCapable {
  readonly fetched: Fetch[] = []
  gated = false
  failing = false
  disposed = 0
  host: SlideSourceHost | null = null
  private readonly gates: Array<() => void> = []
  prepare = async (p: NVSlidePlaneIndex, _signal?: AbortSignal) =>
    this.planeManifest(p)
  constructor(
    readonly manifest: NVSlideManifest,
    private readonly value?: number,
    private readonly Samples: new (
      n: number,
    ) => NVSlideSampleArray = Uint16Array,
    readonly planes: NVSlidePlaneAxes = { z: 3, t: 1 },
  ) {}
  bind(host: SlideSourceHost): void {
    this.host = host
  }
  planeManifest(p: NVSlidePlaneIndex): NVSlideManifest {
    return {
      ...this.manifest,
      levels: this.manifest.levels.map((l) => ({ ...l, plane: { ...p } })),
    }
  }
  preparePlane(p: NVSlidePlaneIndex, signal?: AbortSignal) {
    return this.prepare(p, signal)
  }
  /** Resolve the oldest `n` held fetches (default all). */
  release(n = this.gates.length): void {
    for (const open of this.gates.splice(0, n)) open()
  }
  /** Fetches of plane `z`. */
  of(z: number): Fetch[] {
    return this.fetched.filter((f) => (f.level.plane?.z ?? 0) === z)
  }
  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.fetched.push({ level, tile, signal })
    if (this.gated) await new Promise<void>((open) => this.gates.push(open))
    if (this.failing) throw new Error('tile fetch failed')
    const value = this.value ?? 10 * ((level.plane?.z ?? 0) + 1)
    const s = new this.Samples(tile.width * tile.height).fill(value)
    return new Uint8Array(s.buffer)
  }
  dispose(): void {
    this.disposed++
  }
}

describe('NVSlide source lifetime', () => {
  it('disposes an owned source once, and a borrowed one never', () => {
    const source = new GraySource(grayManifest())
    const slide = NVSlide.fromSource(source)
    slide.dispose()
    slide.dispose()
    expect(source.disposed).toBe(1)
    const borrowed = new GraySource(grayManifest())
    NVSlide.fromSource(borrowed, { ownsSource: false }).dispose()
    expect(borrowed.disposed).toBe(0)
  })

  it('a throwing source dispose still settles pending loadSampleAt', async () => {
    const source = new GraySource(grayManifest())
    // Ignores abort, so only dispose's clearCache can settle the waiter.
    source.fetchTileBytes = () => new Promise<Uint8Array>(() => {})
    source.dispose = () => {
      throw new Error('boom')
    }
    const slide = NVSlide.fromSource(source)
    const pending = slide.loadSampleAt(1, 1)
    await Promise.resolve()
    expect(() => slide.dispose()).toThrow('boom')
    expect((await pending)[0]?.missing).toBe('uncached')
  })
})

describe('NVSlide single-channel samples', () => {
  it('one channelInfo entry reads, fetches and budgets as none', async () => {
    const screen = { widthCss: 2 * T, heightCss: 2 * T, devicePixelRatio: 1 }
    const loaded = async (channelInfo?: NVSlideChannelInfo[]) => {
      const source = new GraySource(grayManifest(2, {}, channelInfo), 7)
      const slide = NVSlide.fromSource(source)
      slide.setViewport({ centerX: T, centerY: T, scale: 1 })
      for (const [x, y] of [
        [1, 1],
        [T + 1, 1],
        [1, T + 1],
        [T + 1, T + 1],
      ] as const)
        await slide.loadSampleAt(x, y)
      return { slide, source }
    }
    const base = await loaded()
    const one = await loaded([{ name: 'c', active: true }])
    for (const { slide, source } of [base, one]) {
      expect(slide.channels.map((c) => c.colormap)).toEqual(['gray'])
      expect(slide.channelBlend).toBe('max')
      // No refetch on hide or show.
      slide.setChannel(0, { visible: false })
      slide.setChannel(0, { visible: true })
      expect(source.fetched).toHaveLength(4)
      expect(slide.sampleAt(1, 1)[0]).toMatchObject({ stored: 7, exact: true })
    }
    const tiles = (s: NVSlide) => s.visibleTiles(screen).tiles.map((t) => t.key)
    expect(tiles(one.slide)).toEqual(tiles(base.slide))
    const level = base.slide.manifest.levels[0] as NVSlideLevelManifest
    const budget = { tileBytes: 128 * MiB, rawPoolBytes: 32 * MiB }
    expect(
      tileCapacity(one.slide.manifest, level, 1e6, undefined, budget),
    ).toEqual(tileCapacity(base.slide.manifest, level, 1e6, undefined, budget))
    base.slide.dispose()
    one.slide.dispose()
  })

  it('channelInfo on an RGB bytes source throws; several on a grey one warn', async () => {
    const rgb = grayManifest(2, { codec: 'image/jpeg' }, [
      { name: 'c', active: true },
    ])
    const source = new GraySource(rgb)
    expect(() => NVSlide.fromSource(source)).toThrow(/monochrome/)
    expect(source.disposed).toBe(0) // a constructor that throws leaves it
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const info = ['a', 'b', 'c'].map((name) => ({ name, active: true }))
    const slide = NVSlide.fromSource(
      new GraySource(grayManifest(2, {}, info), 7),
    )
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/only channel 0/)
    warn.mockRestore()
    const samples = await slide.loadSampleAt(1, 1)
    expect(samples.map((s) => s.stored)).toEqual([7, null, null])
    expect(samples.map((s) => s.missing)).toEqual([
      undefined,
      'uncached',
      'uncached',
    ])
    slide.dispose()
  })

  it('an exact rescale is exact at level 0 and never clipped', async () => {
    const map = { scale: 2, offset: -1024, quantized: false }
    const info = [{ name: 'ct', active: true, storedToValue: map }]
    const slide = NVSlide.fromSource(
      new GraySource(grayManifest(2, {}, info), 0),
    )
    const [s] = await slide.loadSampleAt(1, 1)
    expect(s).toMatchObject({ stored: 0, value: -1024, exact: true })
    expect(s?.clipped).toBeUndefined()
    slide.dispose()
  })

  it('toValue/toStored invert; quantized stored values are integers', () => {
    expect(toValue(3)).toBe(3)
    expect(toStored(3)).toBe(3)
    const exact = { scale: 0.5, offset: 1, quantized: false }
    expect(toStored(toValue(3, exact), exact)).toBe(3)
    expect(toStored(1.25, exact)).toBe(0.5)
    // A quantized map rounds: float error never leaves a fractional sample.
    const q = { scale: 6 / 65535, offset: -3 }
    for (let s = 0; s <= 65535; s += 97)
      expect(toStored(toValue(s, q), q)).toBe(s)
  })

  it('an i16 tile reads signed, clipped at its range end, and counts 2 bytes; f32 counts 4', async () => {
    const info = [
      { name: 'c', active: true, storedToValue: { scale: 1, offset: 0 } },
    ]
    const i16 = new GraySource(
      grayManifest(2, { sampleType: 'i16' }, info),
      -32768,
      Int16Array,
    )
    const slide = NVSlide.fromSource(i16)
    expect((await slide.loadSampleAt(1, 1))[0]).toMatchObject({
      stored: -32768,
      clipped: true,
    })
    const level0 = slide.manifest.levels[0] as NVSlideLevelManifest
    const samples = slide.cachedTile(slide.tileKey(level0, { x: 0, y: 0 }))
      ?.samples?.samples
    expect(samples && rawFormat(samples)).toBe('i16')
    slide.dispose()
    const f32 = new GraySource(
      grayManifest(2, { sampleType: 'f32', bitsStored: 32 }),
      0.5,
      Float32Array,
    )
    const fs = NVSlide.fromSource(f32)
    expect((await fs.loadSampleAt(1, 1))[0]?.stored).toBe(0.5)
    fs.dispose()
    const budget = { tileBytes: 1e12, rawPoolBytes: 0 }
    const cap = (level: Partial<NVSlideLevelManifest>) => {
      const m = grayManifest(2, level)
      const l0 = m.levels[0] as NVSlideLevelManifest
      return tileCapacity(m, l0, 64 * T * T * 4, undefined, budget).tiles
    }
    // 0.75 of 64 tiles' bytes at 4 bytes a pixel: 48 f32 tiles, 96 at 2 bytes.
    expect(cap({ sampleType: 'f32', bitsStored: 16 })).toBe(48)
    expect(cap({ sampleType: 'i16' })).toBe(96)
  })

  it('a source window shows until the user sets one; readout takes the map', async () => {
    const source = new GraySource(
      grayManifest(2, {}, [{ name: 'c', active: true }]),
      7,
    )
    const slide = NVSlide.fromSource(source)
    const host = source.host as SlideSourceHost
    host.channelInfoChanged(0, {
      window: { calMin: 10, calMax: 20 },
      storedToValue: { scale: 2, offset: 1 },
    })
    expect(slide.channels[0]).toMatchObject({ calMin: 10, calMax: 20 })
    expect(slide.manifest.channelInfo?.[0]?.window).toEqual({
      calMin: 10,
      calMax: 20,
    })
    // The source's own manifest is left alone.
    expect(source.manifest.channelInfo?.[0]?.window).toBeUndefined()
    expect((await slide.loadSampleAt(1, 1))[0]).toMatchObject({
      stored: 7,
      value: 15,
    })
    slide.setChannel(0, { calMin: 1, calMax: 2 })
    host.channelInfoChanged(0, { window: { calMin: 30, calMax: 40 } })
    expect(slide.channels[0]).toMatchObject({ calMin: 1, calMax: 2 })
    expect(() => host.channelInfoChanged(1, {})).toThrow(RangeError)
    slide.dispose()
  })
})

describe('NVSlide renderer budget', () => {
  // 32 x 32 tiles of 256 px: a full view needs 1024 tiles, so the texture
  // budget, not the cache, caps it.
  function bigSlide() {
    const n = 32
    const m = grayManifest(n, { tileWidth: 256, tileHeight: 256 })
    m.tileSize = 256
    m.width = m.height = 256 * n
    const level = m.levels[0] as NVSlideLevelManifest
    level.width = level.height = 256 * n
    level.tiles = level.tiles.map((t) => t && { ...t, width: 256, height: 256 })
    const slide = NVSlide.fromSource(new GraySource(m), {
      maxCacheBytes: 1 << 30,
    })
    slide.setViewport({ centerX: 128 * n, centerY: 128 * n, scale: 1 })
    return slide
  }
  const screen = { widthCss: 8192, heightCss: 8192, devicePixelRatio: 1 }

  it('a renderer with a 64 MiB pool caps what a HUD sees until it stops drawing the slide', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const slide = bigSlide()
    const unregistered = slide.visibleTiles(screen).tiles.length
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /96 MiB for scalar slides, 128 for RGB/,
    )
    const renderer = new SlideRenderer({ maxRawPoolBytes: 64 * MiB })
    // Not initialised: render registers the budget, then does nothing.
    renderer.render([slide], screen)
    const hud = slide.visibleTiles(screen).tiles.length
    expect(hud / unregistered).toBeCloseTo(64 / 96, 1)
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(
      /64 MiB for scalar slides, 128 for RGB/,
    )
    // The outcome is unchanged frame to frame: no second warning.
    const warned = warn.mock.calls.length
    slide.visibleTiles(screen)
    expect(warn.mock.calls.length).toBe(warned)
    // The smallest registered budget wins.
    const other = {}
    slide.setRendererBudget(other, { tileBytes: 128 * MiB, rawPoolBytes: 0 })
    expect(slide.visibleTiles(screen).tiles.length).toBe(hud)
    // A renderer drops slides it no longer draws.
    renderer.render([], screen)
    slide.setRendererBudget(other, null)
    expect(slide.visibleTiles(screen).tiles.length).toBe(unregistered)
    warn.mockRestore()
    slide.dispose()
  })

  it('a budget that flaps back between frames does not warn again', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const slide = bigSlide()
    const renderer = {}
    const budget = { tileBytes: 128 * MiB, rawPoolBytes: 64 * MiB }
    slide.setRendererBudget(renderer, budget)
    slide.visibleTiles(screen)
    const warned = warn.mock.calls.length
    slide.setRendererBudget(renderer, null)
    slide.setRendererBudget(renderer, budget)
    slide.visibleTiles(screen)
    expect(warn.mock.calls.length).toBe(warned)
    warn.mockRestore()
    slide.dispose()
  })

  it('clearing a view slide plane unregisters its plane renderer', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    for (const View of [NVViewGL, NVViewGPU]) {
      const slide = bigSlide()
      const unregistered = slide.visibleTiles(screen).tiles.length
      const view = Object.create(View.prototype) as NVViewGL | NVViewGPU
      const renderer = {
        _budget: new SlideBudgetRegistration({}, 64 * MiB),
        clearBudget() {
          this._budget.clear()
        },
      }
      Object.assign(view, { slidePlaneRenderer: renderer })
      view.slidePlane = { slide } as SlidePlaneState
      renderer._budget.sync([slide]) // as draw does
      expect(slide.visibleTiles(screen).tiles.length).toBeLessThan(unregistered)
      view.slidePlane = null
      expect(slide.visibleTiles(screen).tiles.length).toBe(unregistered)
      slide.dispose()
    }
    warn.mockRestore()
  })
})

// 2 x 2 tiles of T px, all in view at 1:1.
const VIEW = { widthCss: 2 * T, heightCss: 2 * T, devicePixelRatio: 1 }

/** A plane slide drawn once and resident, unless `draw` is false. */
async function planeSlide(manifest = grayManifest(2), draw = true) {
  const source = new GraySource(manifest)
  const slide = NVSlide.fromSource(source)
  slide.setViewport({ centerX: T, centerY: T, scale: 1 })
  if (draw) {
    slide.requestVisibleTiles(VIEW)
    await waitFor(() => slide.pendingCount === 0)
  }
  return { slide, source }
}

const drawnKeys = (slide: NVSlide) => {
  const { tiles, fallback } = slide.visibleTiles(VIEW)
  return [...fallback, ...tiles].map((t) => t.key)
}

// Level 0 of plane z (the key producer is NVSlide.tileKey).
const planeLevel = (slide: NVSlide, z: number): NVSlideLevelManifest => ({
  ...(slide.manifest.levels[0] as NVSlideLevelManifest),
  plane: { z, t: 0 },
})

describe('NVSlide planes', () => {
  it('P1: after a switch resolves true, samples read the new plane and nothing drawn is z0', async () => {
    const { slide, source } = await planeSlide()
    let changes = 0
    slide.addEventListener('planechange', () => changes++)
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(10)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect([slide.planeIndex, changes]).toEqual([{ z: 1, t: 0 }, 1])
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(20)
    const keys = drawnKeys(slide)
    expect(keys).toHaveLength(4)
    expect(keys.filter((key) => key.startsWith('z0'))).toEqual([])
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    // The old plane stayed in the LRU: switching back is warm.
    const fetches = source.fetched.length
    expect(await slide.setPlaneIndex({ z: 0, t: 0 })).toBe(true)
    expect(source.fetched.length).toBe(fetches)
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(10)
    slide.dispose()
  })

  it('P2: a failed prepare leaves the plane, tiles and cache unchanged', async () => {
    const { slide, source } = await planeSlide()
    source.prepare = async () => {
      throw new Error('no such plane')
    }
    const manifest = slide.manifest
    const keys = drawnKeys(slide)
    const bytes = slide.cacheBytes
    const fetches = source.fetched.length
    await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
      'no such plane',
    )
    expect(slide.manifest).toBe(manifest)
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    expect(drawnKeys(slide)).toEqual(keys)
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    expect([slide.cacheBytes, source.fetched.length]).toEqual([bytes, fetches])
    slide.dispose()
  })

  it('P3: z0 -> 1 -> 2 in one tick: the first resolves false, only z2 commits', async () => {
    const { slide, source } = await planeSlide()
    const commits: number[] = []
    slide.addEventListener('planechange', () =>
      commits.push(slide.planeIndex.z),
    )
    const one = slide.setPlaneIndex({ z: 1, t: 0 })
    const two = slide.setPlaneIndex({ z: 2, t: 0 })
    expect([await one, await two]).toEqual([false, true])
    expect(commits).toEqual([2])
    expect(source.of(1)).toEqual([]) // superseded before its hold: no z1 load
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(30)
    slide.dispose()
  })

  it('P3: superseded during its hold, z1 resolves false and its loads count as aborted', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    const one = slide.setPlaneIndex({ z: 1, t: 0 })
    await waitFor(() => source.of(1).length === 4)
    const aborted = slide.stats.aborted
    const two = slide.setPlaneIndex({ z: 2, t: 0 })
    expect(await one).toBe(false)
    expect(source.of(1).every((f) => f.signal?.aborted)).toBe(true)
    await waitFor(() => source.of(2).length === 4)
    source.release()
    expect(await two).toBe(true)
    await waitFor(() => slide.stats.aborted === aborted + 4)
    const z1 = planeLevel(slide, 1)
    expect(slide.cachedTile(slide.tileKey(z1, { x: 0, y: 0 }))).toBeNull()
    expect(slide.planeIndex).toEqual({ z: 2, t: 0 })
    slide.dispose()
  })

  it('P4: a z0 load that resolves after the commit is not cached', async () => {
    // Nothing drawn (a prefetch owner is not held for): the switch commits at once.
    const { slide, source } = await planeSlide(grayManifest(2), false)
    source.gated = true
    const owner = slide.createRequestOwner('prefetch')
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    owner.want(
      level.tiles.map((tile) => ({ level, tile: tile as NVSlideTileManifest })),
    )
    expect(source.of(0)).toHaveLength(4)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(source.of(0).every((f) => f.signal?.aborted)).toBe(true)
    source.release() // the z0 bytes arrive after the commit
    await waitFor(() => slide.stats.aborted === 4)
    expect([slide.stats.completed, slide.cacheBytes]).toEqual([0, 0])
    expect(slide.cachedTile(slide.tileKey(level, { x: 0, y: 0 }))).toBeNull()
    owner.release()
    slide.dispose()
  })

  it('P7: a plane whose sample mapping or geometry differs is rejected at commit', async () => {
    const info = [
      { name: 'c', active: true, storedToValue: { scale: 2, offset: 0 } },
    ]
    const { slide, source } = await planeSlide(grayManifest(2, {}, info))
    const changes: Array<(m: NVSlideManifest) => void> = [
      (m) => {
        m.channelInfo = [{ ...info[0], storedToValue: { scale: 3, offset: 0 } }]
      },
      (m) => {
        ;(m.levels[0] as NVSlideLevelManifest).sampleType = 'i16'
      },
      (m) => {
        ;(m.levels[0] as NVSlideLevelManifest).bitsStored = 12
      },
      (m) => {
        m.width += 1
      },
    ]
    for (const change of changes) {
      source.prepare = async (p) => {
        const m = source.planeManifest(p)
        m.levels = m.levels.map((l) => ({ ...l }))
        change(m)
        return m
      }
      await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
        RangeError,
      )
      expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    }
    expect(source.of(1)).toEqual([])
    // The same plane, unchanged, commits.
    source.prepare = async (p) => source.planeManifest(p)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(slide.sampleAt(1, 1)[0]).toMatchObject({ stored: 20, value: 40 })
    slide.dispose()
  })

  it('holds the old plane on screen until the new plane is resident', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    let committed: boolean | undefined
    const switching = slide.setPlaneIndex({ z: 1, t: 0 }).then((ok) => {
      committed = ok
    })
    await waitFor(() => source.of(1).length === 4)
    source.release(3)
    await waitFor(() => slide.pendingCount === 1)
    // Three of four z1 tiles resident: still the whole old plane.
    expect(committed).toBeUndefined()
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    expect(drawnKeys(slide).every((key) => key.startsWith('z0t0/'))).toBe(true)
    expect(slide.requestVisibleTiles(VIEW).fallback).toEqual([])
    source.release()
    await switching
    expect(committed).toBe(true)
    const keys = drawnKeys(slide)
    expect(keys.every((key) => key.startsWith('z1t0/'))).toBe(true)
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    slide.dispose()
  })

  it('a failed tile ends the hold', async () => {
    const { slide, source } = await planeSlide()
    const error = spyOn(console, 'error').mockImplementation(() => {})
    let errors = 0
    slide.addEventListener('tileerror', () => errors++)
    source.gated = true
    const switching = slide.setPlaneIndex({ z: 1, t: 0 })
    await waitFor(() => source.of(1).length === 4)
    source.failing = true
    source.release()
    expect(await switching).toBe(true)
    expect(errors).toBe(4)
    expect(slide.planeIndex).toEqual({ z: 1, t: 0 })
    error.mockRestore()
    slide.dispose()
  })

  // Engine bug: an abort of opts.signal during the hold resolves the hold, and
  // the switch then commits with the new plane's tiles missing.
  it('an abort during the hold rejects and keeps the old plane', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    const stop = new AbortController()
    const switching = slide.setPlaneIndex(
      { z: 1, t: 0 },
      { signal: stop.signal },
    )
    await waitFor(() => source.of(1).length === 4)
    stop.abort()
    await expect(switching).rejects.toThrow()
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    slide.dispose()
  })

  it('dispose aborts a pending plane switch, which settles false', async () => {
    const { slide, source } = await planeSlide()
    let seen: AbortSignal | undefined
    source.prepare = (_p, signal) =>
      new Promise((_resolve, reject) => {
        seen = signal
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    const switching = slide.setPlaneIndex({ z: 1, t: 0 })
    await Promise.resolve()
    slide.dispose()
    expect(seen?.aborted).toBe(true)
    expect(await switching).toBe(false)
  })

  // Engine bug: a pre-aborted signal still switched planes.
  it('a pre-aborted signal rejects AbortError without preparing', async () => {
    const { slide, source } = await planeSlide()
    let prepares = 0
    source.prepare = async (p) => {
      prepares++
      return source.planeManifest(p)
    }
    const stop = new AbortController()
    stop.abort()
    await expect(
      slide.setPlaneIndex({ z: 1, t: 0 }, { signal: stop.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect([slide.planeIndex, prepares]).toEqual([{ z: 0, t: 0 }, 0])
    slide.dispose()
  })

  // Engine bug: with only the 3D plane drawn nothing was held, and with 2D + 3D
  // only the 2D view's tiles were.
  it('holds the 3D plane: alone, and beside the 2D view', async () => {
    for (const draw2d of [false, true]) {
      const { slide, source } = await planeSlide(grayManifest(2), false)
      const level = slide.manifest.levels[0] as NVSlideLevelManifest
      const plane = slide.createRequestOwner('plane3d')
      plane.want(
        level.tiles.map((tile) => ({
          level,
          tile: tile as NVSlideTileManifest,
        })),
      )
      // The 2D view shows tile (0, 0) only.
      if (draw2d) slide.requestVisibleTiles({ widthCss: T, heightCss: T })
      await waitFor(() => slide.pendingCount === 0)
      source.gated = true
      let committed: boolean | undefined
      const switching = slide.setPlaneIndex({ z: 1, t: 0 }).then((ok) => {
        committed = ok
      })
      await waitFor(() => source.of(1).length === 4)
      source.release(3)
      await waitFor(() => slide.pendingCount === 1)
      expect([committed, slide.planeIndex]).toEqual([undefined, { z: 0, t: 0 }])
      source.release()
      await switching
      expect(committed).toBe(true)
      const z1 = planeLevel(slide, 1)
      for (const tile of level.tiles)
        expect(
          slide.cachedTile(slide.tileKey(z1, tile as NVSlideTileManifest)),
        ).not.toBeNull()
      // A second switch before the owners want again (no frame between)
      // still holds: their z0 keys map to z2.
      let again: boolean | undefined
      const second = slide.setPlaneIndex({ z: 2, t: 0 }).then((ok) => {
        again = ok
      })
      await waitFor(() => source.of(2).length === 4)
      expect([again, slide.planeIndex]).toEqual([undefined, { z: 1, t: 0 }])
      source.release()
      await second
      expect(again).toBe(true)
      plane.release()
      slide.dispose()
    }
  })

  // Engine bug: the hold walked a placed level as a grid, holding the wrong tiles.
  it('holds a placed level by the pieces in view', async () => {
    // Three tiles in a row placed in reverse: tile 2 shows at x 0.
    const manifest = grayManifest(3)
    const l0 = manifest.levels[0] as NVSlideLevelManifest
    manifest.height = l0.height = T
    l0.rows = 1
    l0.tiles = l0.tiles.slice(0, 3)
    l0.placement = {
      width: 3 * T,
      height: T,
      pieces: [2, 1, 0].map((tile, i) => ({
        ...{ tile, sx: 0, sy: 0, sw: T, sh: T },
        ...{ dx: i * T, dy: 0 },
      })),
    }
    const source = new GraySource(manifest)
    const slide = NVSlide.fromSource(source)
    const screen = { widthCss: T / 2, heightCss: T, devicePixelRatio: 1 }
    slide.setViewport({ centerX: T / 4, centerY: T / 2, scale: 1 })
    const shown = slide.requestVisibleTiles(screen).tiles.map((t) => t.tile.x)
    expect(shown).toEqual([2])
    await waitFor(() => slide.pendingCount === 0)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(source.of(1).map((f) => f.tile.x)).toEqual(shown)
    slide.dispose()
  })
})

describe('NVSlide request ownership', () => {
  it('R1: a 5 x 5 view on 1 slot fetches the centre first, then by distance', async () => {
    const source = new GraySource(grayManifest(5))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    slide.setViewport({ centerX: 2.5 * T, centerY: 2.5 * T, scale: 1 })
    slide.requestVisibleTiles({ widthCss: 5 * T, heightCss: 5 * T })
    for (let i = 1; i <= 25; i++) {
      await waitFor(() => source.fetched.length === i)
      source.release()
    }
    const dist = ({ tile }: Fetch) => (tile.x - 2) ** 2 + (tile.y - 2) ** 2
    const order = source.fetched.map(dist)
    expect(source.fetched[0]?.tile).toMatchObject({ x: 2, y: 2 })
    expect(order).toEqual([...order].sort((a, b) => a - b))
    await waitFor(() => slide.pendingCount === 0)
    slide.dispose()
  })

  it('R3: a loadSampleAt aborted before it starts fetches nothing and resolves uncached', async () => {
    const source = new GraySource(grayManifest(2))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const stop = new AbortController()
    stop.abort()
    const early = await slide.loadSampleAt(1, 1, { signal: stop.signal })
    expect(early[0]?.missing).toBe('uncached')
    expect(source.fetched).toEqual([])
    // Queued behind another load, then aborted: dequeued, never fetched.
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    slide
      .createRequestOwner('plane3d')
      .want([{ level, tile: level.tiles[3] as NVSlideTileManifest }])
    const late = new AbortController()
    const queued = slide.loadSampleAt(1, 1, { signal: late.signal })
    late.abort()
    expect((await queued)[0]?.missing).toBe('uncached')
    expect(slide.stats.aborted).toBe(1)
    source.release()
    await waitFor(() => slide.pendingCount === 0)
    expect(source.fetched.map((f) => f.tile)).toEqual([
      level.tiles[3] as NVSlideTileManifest,
    ])
    slide.dispose()
  })

  // Engine bug: an aborted in-flight load stays in _loads until its source
  // settles, and a new owner joins it instead of starting a fresh load.
  it('a tile wanted again right after its load was aborted loads', async () => {
    const source = new GraySource(grayManifest(2))
    source.gated = true
    const slide = NVSlide.fromSource(source)
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const owner = slide.createRequestOwner('plane3d')
    owner.want([{ level, tile: level.tiles[0] as NVSlideTileManifest }])
    owner.release() // aborts the fetch in flight
    const readout = slide.loadSampleAt(1, 1)
    source.release()
    await waitFor(() => source.fetched.length === 2, 500)
    source.release()
    expect((await readout)[0]?.stored).toBe(10)
    slide.dispose()
  })

  it('R5: with 200 view tiles queued on 4 slots, a thumbnail and then a prefetch tile start within 4 dequeues each', async () => {
    // L0: 16 x 16 tiles; L1: 8 x 8.
    const manifest = grayManifest(16)
    const l0 = manifest.levels[0] as NVSlideLevelManifest
    const l1: NVSlideLevelManifest = {
      ...l0,
      index: 1,
      downsample: 2,
      width: l0.width / 2,
      height: l0.height / 2,
      columns: 8,
      rows: 8,
      tiles: l0.tiles.filter((t) => t && t.x < 8 && t.y < 8),
    }
    manifest.levels.push(l1)
    const source = new GraySource(manifest)
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const [level0, level1] = slide.manifest.levels as NVSlideLevelManifest[]
    const tilesOf = (level: NVSlideLevelManifest, n: number) =>
      level.tiles
        .slice(0, n)
        .map((tile) => ({ level, tile: tile as NVSlideTileManifest }))
    slide
      .createRequestOwner('view')
      .want(tilesOf(level0 as NVSlideLevelManifest, 204), { x: 64, y: 64 })
    expect(source.fetched).toHaveLength(4)
    const [thumbTile, prefetchTile] = tilesOf(level1 as NVSlideLevelManifest, 2)
    slide.createRequestOwner('thumbnail').want([thumbTile as Fetch])
    slide.createRequestOwner('prefetch').want([prefetchTile as Fetch])
    const startOf = (t?: Fetch) =>
      source.fetched.findIndex(
        (f) => f.tile === t?.tile && f.level === t?.level,
      )
    while (startOf(prefetchTile) < 0) {
      const n = source.fetched.length
      source.release(1)
      await waitFor(() => source.fetched.length === n + 1)
    }
    // Index 4 is the first dequeue after the two were queued.
    expect(startOf(thumbTile) - 4).toBeLessThan(4)
    expect(startOf(prefetchTile) - startOf(thumbTile)).toBeLessThanOrEqual(4)
    slide.dispose()
  })

  it('R6: dispose with every class queued empties the queue and settles everything', async () => {
    const source = new GraySource(grayManifest(4))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const at = (x: number, y: number) => ({
      level,
      tile: level.tiles[y * 4 + x] as NVSlideTileManifest,
    })
    slide.setViewport({ centerX: T / 2, centerY: T / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: T, heightCss: T }) // view: (0, 0), in flight
    const readout = slide.loadSampleAt(T + 1, 1) // (1, 0)
    slide.createRequestOwner('plane3d').want([at(2, 0)])
    const thumb = slide.createRequestOwner('thumbnail')
    thumb.want([at(3, 0)])
    slide.createRequestOwner('prefetch').want([at(0, 1)])
    expect(slide.pendingCount).toBe(5)
    slide.dispose()
    expect(slide.pendingCount).toBe(0)
    expect((await readout)[0]?.missing).toBe('uncached')
    expect(source.fetched).toHaveLength(1)
    expect(source.fetched[0]?.signal?.aborted).toBe(true)
    source.release()
    await waitFor(() => slide.stats.aborted === 1) // the in-flight view load
    thumb.want([at(3, 1)]) // a released owner wants nothing
    expect(source.fetched).toHaveLength(1)
    expect([slide.stats.completed, slide.cacheBytes]).toEqual([0, 0])
  })
})
