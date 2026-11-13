import { describe, expect, test } from 'bun:test'
import type {
  NVSlideCachedTile,
  NVSlideScreen,
  NVSlideVisibleTile,
} from './NVSlide'
import { NVSlide } from './NVSlide'
import { DEFAULT_RAW_POOL_BYTES, SlideBudgetRegistration } from './slideFuse'
import { cornerQuad } from './slidePlane'
import {
  cropUv,
  frameTextureBudget,
  planTextures,
  SlideFramePlan,
  writeRectNdc,
  writeTileUv,
} from './slideTiles'
import type { GutterAt } from './tileGutter'
import { gutterTextureBytes } from './tileGutter'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from './tileTextureCache'

function tile(key: string, extra: Partial<NVSlideVisibleTile> = {}) {
  return {
    key,
    screenX: 0,
    screenY: 0,
    screenWidth: 10,
    screenHeight: 10,
    flipY: false,
    tile: { x: 0, y: 0, width: 16, height: 16 },
    slide: {},
    ...extra,
  } as NVSlideVisibleTile
}

function fakeSlide(
  fallback: NVSlideVisibleTile[],
  tiles: NVSlideVisibleTile[],
  cached: string[],
): NVSlide {
  return {
    visible: true,
    opacity: 1,
    requestVisibleTiles: () => ({ fallback, tiles }),
    cachedTile: (key: string) => (cached.includes(key) ? { key } : null),
  } as unknown as NVSlide
}

const screen = {} as NVSlideScreen

/** Quads of `plan` as `fallback|tile:key:upload index`. */
function quads(plan: SlideFramePlan): string[] {
  return plan.quads.map(
    (t, i) =>
      `${plan.quadFallback[i] ? 'fallback' : 'tile'}:${t.key}:${plan.quadUpload[i]}`,
  )
}

describe('SlideFramePlan', () => {
  test('cached fallback quads come first, then the target level; every upload precedes the draws', () => {
    const plan = new SlideFramePlan()
    plan.build(
      [
        fakeSlide(
          [tile('f1'), tile('f2')],
          [tile('t1'), tile('t2')],
          ['f1', 't1'],
        ),
      ],
      screen,
    )
    expect(quads(plan)).toEqual(['fallback:f1:0', 'tile:t1:1'])
    expect(plan.uploads.map((t) => t.key)).toEqual(['f1', 't1'])
    expect([plan.slideStart, plan.slideEnd]).toEqual([[0], [2]])
  })

  test('a missing target tile is a placeholder only with no fallback behind it', () => {
    const plan = new SlideFramePlan()
    plan.build([fakeSlide([], [tile('t1')], [])], screen)
    expect(quads(plan)).toEqual(['tile:t1:-1'])
    expect(plan.uploads).toHaveLength(0)
  })

  test('two pieces of one tile upload once; slides sharing a key upload each', () => {
    const plan = new SlideFramePlan()
    const piece = (x: number) =>
      tile('t', { src: { x, y: 0, w: 8, h: 16 }, screenX: x })
    const a = fakeSlide([], [piece(0), piece(8)], ['t'])
    const b = fakeSlide([], [tile('t')], ['t'])
    plan.build([a, b], screen)
    expect(quads(plan)).toEqual(['tile:t:0', 'tile:t:0', 'tile:t:1'])
    expect(plan.uploads).toHaveLength(2)
    expect([plan.slideStart, plan.slideEnd]).toEqual([
      [0, 2],
      [2, 3],
    ])
  })

  test('hidden slides are skipped and arrays are reused', () => {
    const plan = new SlideFramePlan()
    const hidden = fakeSlide([], [tile('t1')], ['t1'])
    Object.assign(hidden, { opacity: 0 })
    const { quads: before } = plan
    plan.build([fakeSlide([], [tile('t1')], ['t1'])], screen)
    plan.build([hidden], screen)
    expect(plan.slides).toHaveLength(0)
    expect(plan.quads).toBe(before)
    expect(plan.quads).toHaveLength(0)
  })
})

describe('frameTextureBudget (ENG-11)', () => {
  const MiB = 1024 * 1024
  test('textures evicted for a fusing frame leave the pool its whole share: <= 128 MiB together', () => {
    const maxPool = DEFAULT_RAW_POOL_BYTES
    const cache = new TileTextureCache<number>(128 * MiB, () => {})
    cache.beginFrame()
    for (let i = 0; i < 8; i++) cache.set(`t${i}`, i, 16 * MiB)
    cache.beginFrame() // the next frame: those tiles are no longer in use
    // RGB only, pool empty: all 128 MiB stay.
    cache.evictToBudget(frameTextureBudget(false, 0, maxPool))
    expect(cache.bytes).toBe(128 * MiB)
    cache.beginFrame()
    // A fusing frame evicts before its fuse fills the (still empty) pool.
    cache.evictToBudget(frameTextureBudget(true, 0, maxPool))
    expect(cache.bytes + maxPool).toBeLessThanOrEqual(128 * MiB)
    cache.beginFrame()
    // A non-empty pool, at the clamp's maximum.
    cache.evictToBudget(frameTextureBudget(false, 1, 64 * MiB))
    expect(cache.bytes + 64 * MiB).toBeLessThanOrEqual(128 * MiB)
  })

  test('the plan reports a frame with a scalar upload', () => {
    const plan = new SlideFramePlan()
    const slide = fakeSlide([], [tile('t1')], ['t1'])
    plan.build([slide], screen)
    expect(plan.fuses).toBe(false)
    Object.assign(slide, { cachedTile: () => ({ samples: {} }) })
    plan.build([slide], screen)
    expect(plan.fuses).toBe(true)
  })
})

describe('planTextures (ENG-11)', () => {
  /**
   * One frame as the renderers run it: evict, begin, then each plan tile's
   * resident texture or an upload that reserves room (else deferred).
   */
  const source = {}
  function frame(
    cache: TileTextureCache<string>,
    keys: readonly string[],
    bytes: number,
  ): (string | null)[] {
    const at = keys.map((key) => ({ key }) as GutterAt)
    const cached = keys.map(() => ({ bitmap: source }) as NVSlideCachedTile)
    cache.evictToBudget()
    cache.beginFrame()
    const out: (string | null)[] = []
    planTextures(
      cache,
      at,
      cached,
      (i) => {
        const key = keys[i] as string
        const hit = cache.get(key, source)
        if (hit) return hit
        if (!cache.reserve(bytes)) return null
        cache.set(key, key, bytes, source)
        return key
      },
      out,
    )
    return out
  }

  test('an upload evicts no texture the frame draws', () => {
    const destroyed: string[] = []
    const cache = new TileTextureCache<string>(5, (v) => destroyed.push(v))
    // b..e and x drawn last frame (x most recent); a pan drops x and brings
    // n in first: n's room must come from x, not from b, the oldest.
    frame(cache, ['b', 'c', 'd', 'e', 'x'], 1)
    for (let i = 0; i < 3; i++)
      expect(frame(cache, ['n', 'b', 'c', 'd', 'e'], 1)).toEqual([
        'n',
        'b',
        'c',
        'd',
        'e',
      ])
    expect(destroyed).toEqual(['x'])
  })

  test('two slides near the budget both draw: each is capped to its share', () => {
    // 32 x 32 RGB tiles of 256 px in an 8192 px view: the texture budget caps each.
    const big = () => {
      const n = 32
      const tiles = []
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          tiles.push({ x, y, width: 256, height: 256 })
      const size = 256 * n
      const slide = NVSlide.fromSource(
        {
          manifest: {
            id: 'big',
            name: 'big',
            width: size,
            height: size,
            dtype: 'uint8',
            channels: 'rgba',
            levels: [
              {
                index: 0,
                width: size,
                height: size,
                downsample: 1,
                tileWidth: 256,
                tileHeight: 256,
                columns: n,
                rows: n,
                codec: 'raw-rgba',
                tiles,
              },
            ],
          },
          bind() {},
          fetchTileBytes: async () => new Uint8Array(0),
        },
        { maxCacheBytes: 1 << 30 },
      )
      slide.setViewport({ centerX: size / 2, centerY: size / 2, scale: 1 })
      return slide
    }
    const view = { widthCss: 8192, heightCss: 8192, devicePixelRatio: 1 }
    const slides = [big(), big()]
    new SlideBudgetRegistration({}, DEFAULT_RAW_POOL_BYTES).sync(slides)
    const keys = slides.flatMap((s, i) =>
      s.visibleTiles(view).tiles.map((t) => `${i}:${t.key}`),
    )
    const cache = new TileTextureCache<string>(
      DEFAULT_TILE_TEXTURE_BYTES,
      () => {},
    )
    const bytes = gutterTextureBytes(256, 256)
    let drawn: (string | null)[] = []
    for (let i = 0; i < 4; i++) drawn = frame(cache, keys, bytes)
    expect(drawn.filter((t) => t === null)).toHaveLength(0)
    expect(cache.bytes).toBeLessThanOrEqual(DEFAULT_TILE_TEXTURE_BYTES)
    for (const s of slides) s.dispose()
  })
})

describe('writeTileUv', () => {
  test('a crop gives its span; y-up swaps top and bottom', () => {
    const out = [0, 0, 0, 0]
    const src = { x: 4, y: 0, w: 8, h: 4 }
    writeTileUv(tile('t', { src }), out, 0)
    expect(out).toEqual([0.25, 0, 0.75, 0.25])
    writeTileUv(tile('t', { src, flipY: true }), out, 0)
    expect(out).toEqual([0.25, 0.25, 0.75, 0])
    writeTileUv(tile('t', { flipY: true }), out, 0)
    expect(out).toEqual([0, 1, 1, 0])
  })
})

describe('cropUv', () => {
  test('a 1.5 px overlap split at its midpoint crops 0.75 px: a fractional UV', () => {
    const size = { width: 16, height: 16 }
    const [u0, v0, u1, v1] = cropUv(size, { x: 0, y: 0, w: 16 - 0.75, h: 16 })
    expect([u0, v0, v1]).toEqual([0, 0, 1])
    expect(u1).toBe(15.25 / 16)
    // Through a 1-texel gutter: texel 1 + 15.25 of 18.
    const quad = cornerQuad(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ],
      size,
      [u0, v0, u1, v1],
    )
    expect(quad[8]).toBeCloseTo(16.25 / 18, 6)
    expect(cropUv(size)).toEqual([0, 0, 1, 1])
  })
})

describe('writeRectNdc', () => {
  test('maps a screen rect to clip space, y up', () => {
    const out = [0, 0, 0, 0]
    expect(writeRectNdc(0, 0, 50, 25, 100, 50, out, 0)).toBe(true)
    expect(out).toEqual([-1, 1, 0, 0])
  })

  test('drops empty and off-screen rects', () => {
    const out: number[] = []
    expect(writeRectNdc(0, 0, 0, 5, 100, 50, out, 0)).toBe(false)
    expect(writeRectNdc(101, 0, 5, 5, 100, 50, out, 0)).toBe(false)
    expect(writeRectNdc(-6, 0, 5, 5, 100, 50, out, 0)).toBe(false)
    expect(out).toHaveLength(0)
  })
})
