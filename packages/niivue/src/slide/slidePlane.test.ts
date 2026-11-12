import { describe, expect, test } from 'bun:test'

import {
  NVSlide,
  type NVSlideLevelManifest,
  type NVSlideManifest,
  type NVSlideTileManifest,
} from './NVSlide'
import { tileCapacity } from './slideLod'
import {
  axialPlaneTransform,
  beginSlidePlaneFrame,
  cornerQuad,
  pickSlidePixel,
  pickSlideWorld,
  releaseSlidePlane,
  resolveSlidePlaneTiles,
  type SlidePlaneState,
  selectSlidePlaneLevel,
  slideExtentCorners,
  slidePlaneTiles,
} from './slidePlane'
import type { SlideTileSource } from './slideSource'

// One view frame with one RENDER viewport: begin it, then resolve.
const resolveFrame = (...a: Parameters<typeof resolveSlidePlaneTiles>) => {
  beginSlidePlaneFrame(a[0])
  return resolveSlidePlaneTiles(...a)
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

// Column-major 4x4 identity: clip == world, so ndc == world (w = 1).
const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
])

// Serves raw-gray u8 tiles, held while `gate` is pending; records each fetch.
class PlaneSource implements SlideTileSource {
  readonly fetched: {
    level: NVSlideLevelManifest
    tile: NVSlideTileManifest
  }[] = []
  gate: Promise<void> = Promise.resolve()
  constructor(readonly manifest: NVSlideManifest) {}
  bind(): void {}
  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): Promise<Uint8Array> {
    this.fetched.push({ level, tile })
    await this.gate
    return new Uint8Array(tile.width * tile.height)
  }
}

function makeSlide(
  levels: NVSlideLevelManifest[],
  width: number,
  height: number,
  options: { maxCacheBytes?: number; maxConcurrentLoads?: number } = {},
) {
  const manifest: NVSlideManifest = {
    id: 'plane',
    name: 'plane',
    width,
    height,
    tileSize: 256,
    dtype: 'uint8',
    channels: 'gray',
    levels,
  }
  const source = new PlaneSource(manifest)
  const slide = NVSlide.fromSource(source, options)
  const fetched = () =>
    source.fetched.map((f) => slide.tileKey(f.level, f.tile))
  return { slide, source, fetched }
}

function pyramidLevel(
  index: number,
  downsample: number,
  cols: number,
  rows: number,
): NVSlideLevelManifest {
  const tiles = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tiles.push({ x, y, width: 256, height: 256 })
    }
  }
  return {
    index,
    width: cols * 256,
    height: rows * 256,
    downsample,
    tileWidth: 256,
    tileHeight: 256,
    columns: cols,
    rows,
    codec: 'raw-gray',
    bitsStored: 8,
    tiles,
  }
}

function level(): NVSlideLevelManifest {
  // 2x1 tiles, 256px tiles, downsample 1 (level 0), 512x256 image.
  return {
    index: 0,
    width: 512,
    height: 256,
    downsample: 1,
    tileWidth: 256,
    tileHeight: 256,
    columns: 2,
    rows: 1,
    codec: 'raw-gray',
    bitsStored: 8,
    tiles: [
      { x: 0, y: 0, width: 256, height: 256 },
      { x: 1, y: 0, width: 256, height: 256 },
    ],
  }
}

describe('axialPlaneTransform', () => {
  test('maps slide corners onto the requested world extents (flipY)', () => {
    const m = axialPlaneTransform(512, 256, {
      xmin: -90,
      xmax: 90,
      ymin: -110,
      ymax: 90,
      z: 5,
    })
    const at = (px: number, py: number): [number, number, number] => [
      m[0] * px + m[4] * py + m[12],
      m[1] * px + m[5] * py + m[13],
      m[2] * px + m[6] * py + m[14],
    ]
    // (0,0) -> (xmin, ymax) with flipY; (W,H) -> (xmax, ymin); all at z.
    expect(at(0, 0)).toEqual([-90, 90, 5])
    expect(at(512, 256)).toEqual([90, -110, 5])
  })
})

describe('slidePlaneTiles', () => {
  test('produces one world quad per tile, contiguous across the plane', () => {
    const m = axialPlaneTransform(512, 256, {
      xmin: 0,
      xmax: 512,
      ymin: 0,
      ymax: 256,
      flipY: false,
      z: 0,
    })
    const { slide } = makeSlide([level()], 512, 256)
    const l0 = slide.manifest.levels[0] as NVSlideLevelManifest
    const quads = slidePlaneTiles(slide, l0, m)
    expect(quads).toHaveLength(2)
    // Identity-like transform (extents == pixels): corners == base pixels at z=0.
    expect(quads[0].key).toBe(slide.tileKey(l0, { x: 0, y: 0 }))
    expect(quads[0].level).toBe(l0)
    expect(quads[1].tile).toBe(l0.tiles[1] as NVSlideTileManifest)
    expect(quads[0].corners[0]).toEqual([0, 0, 0]) // top-left
    expect(quads[0].corners[3]).toEqual([256, 256, 0]) // bottom-right
    // Tile 1 starts where tile 0 ends in x (contiguous, no gap/overlap).
    expect(quads[1].corners[0]).toEqual([256, 0, 0])
    expect(quads[1].corners[3]).toEqual([512, 256, 0])
  })
})

// pixelToWorld mapping slide [0,W]x[0,H] onto world (== ndc with IDENTITY) [-1,1].
function unitTransform(w: number, h: number): number[] {
  return axialPlaneTransform(w, h, {
    xmin: -1,
    xmax: 1,
    ymin: -1,
    ymax: 1,
    z: 0,
    flipY: false,
  })
}

describe('selectSlidePlaneLevel', () => {
  // 3-level pyramid: downsample 1 / 2 / 4. Base = 512x512.
  const levels = [
    pyramidLevel(0, 1, 2, 2),
    pyramidLevel(1, 2, 1, 1),
    pyramidLevel(2, 4, 1, 1),
  ]
  const state = (levelIndex?: number): SlidePlaneState => ({
    slide: makeSlide(levels, 512, 512).slide,
    pixelToWorld: unitTransform(512, 512),
    levelIndex,
  })

  test('picks the finest level when one base pixel ~ one screen pixel', () => {
    // viewport 512 wide => screen px per base px = 512/512 = 1 => downsample ~1.
    expect(selectSlidePlaneLevel(state(), IDENTITY, 512, 512).index).toBe(0)
  })

  test('picks a coarser level as the plane shrinks on screen', () => {
    // viewport 128 => 0.25 screen px per base px => want downsample ~4.
    expect(selectSlidePlaneLevel(state(), IDENTITY, 128, 128).index).toBe(2)
  })

  test('honours a pinned levelIndex (LOD off)', () => {
    expect(selectSlidePlaneLevel(state(1), IDENTITY, 512, 512).index).toBe(1)
  })

  test('resolves a pinned manifest level identifier, not its array position', () => {
    const nonContiguous = [
      pyramidLevel(2, 1, 2, 2),
      pyramidLevel(7, 2, 1, 1),
      pyramidLevel(11, 4, 1, 1),
    ]
    const pinned: SlidePlaneState = {
      slide: makeSlide(nonContiguous, 512, 512).slide,
      pixelToWorld: unitTransform(512, 512),
      levelIndex: 7,
    }
    expect(selectSlidePlaneLevel(pinned, IDENTITY, 512, 512).index).toBe(7)
  })

  test('holds the level within the shared 1.1 hysteresis band', () => {
    const held = state()
    // One base px is w / 512 device px under IDENTITY.
    const at = (s: SlidePlaneState, w: number) =>
      resolveFrame(s, IDENTITY, w, w).level.index
    expect(at(held, 384)).toBe(0) // 0.75
    expect(at(state(), 358)).toBe(1) // fresh at 0.7: below the target
    expect(at(held, 358)).toBe(0) // held: within 0.75 / 1.1
    expect(at(held, 348)).toBe(1) // 0.68: past the band
    expect(at(held, 410)).toBe(1) // 0.8: held under 0.75 * 1.1
    expect(at(held, 425)).toBe(0) // 0.83
    held.slide.dispose()
  })

  test('an invalid pinned level falls back to camera-driven selection', () => {
    expect(
      selectSlidePlaneLevel(state(Number.NaN), IDENTITY, 512, 512).index,
    ).toBe(0)
  })
})

const planeState = (slide: NVSlide): SlidePlaneState => ({
  slide,
  pixelToWorld: unitTransform(slide.manifest.width, slide.manifest.height),
})

describe('resolveSlidePlaneTiles', () => {
  test('wants and returns the on-screen tiles of the chosen level', () => {
    const { slide, fetched } = makeSlide([pyramidLevel(0, 1, 2, 2)], 512, 512)
    const state = planeState(slide)
    const { level, tiles } = resolveFrame(state, IDENTITY, 512, 512)
    expect(level.index).toBe(0)
    expect(tiles).toHaveLength(4) // whole plane on screen
    expect(fetched()).toHaveLength(4)
    // Plane tiles are built once per level: stable identity across frames.
    const again = resolveFrame(state, IDENTITY, 512, 512)
    expect(state.tilesByLevel?.get(level)).toBeDefined()
    expect(again.tiles).toEqual(tiles)
    expect(again.tiles.every((t, i) => t === tiles[i])).toBe(true)
    slide.dispose()
  })

  test('skips the holes of a sparse level and requests the right tiles', () => {
    // 2x2 with the top-right and bottom-left tiles missing: the culled plane
    // tiles must still map to their own manifest tiles, not by array position.
    const sparse = pyramidLevel(0, 1, 2, 2)
    sparse.tiles[1] = null
    sparse.tiles[2] = null
    const { slide, fetched } = makeSlide([sparse], 512, 512)
    const l0 = slide.manifest.levels[0] as NVSlideLevelManifest
    const keys = [
      slide.tileKey(l0, { x: 0, y: 0 }),
      slide.tileKey(l0, { x: 1, y: 1 }),
    ]
    const { tiles } = resolveFrame(planeState(slide), IDENTITY, 512, 512)
    expect(tiles.map((t) => t.key)).toEqual(keys)
    expect(fetched()).toEqual(keys)
    slide.dispose()
  })

  test('culls every tile when the plane is off-screen', () => {
    const { slide, fetched } = makeSlide([pyramidLevel(0, 1, 2, 2)], 512, 512)
    // Shove the plane far to the right in clip space (m[12] = +10).
    const off = new Float32Array(IDENTITY)
    off[12] = 10
    const { tiles, drawn } = resolveFrame(planeState(slide), off, 512, 512)
    expect([tiles, drawn]).toEqual([[], []])
    expect(fetched()).toHaveLength(0)
    slide.dispose()
  })

  test('settles: a still camera stops creating loads once resident', async () => {
    const levels = [pyramidLevel(0, 1, 2, 2), pyramidLevel(1, 2, 1, 1)]
    const { slide } = makeSlide(levels, 512, 512)
    const state = planeState(slide)
    const first = resolveFrame(state, IDENTITY, 512, 512)
    await waitFor(() => slide.pendingCount === 0)
    const requested = slide.stats.requested
    expect(requested).toBe(5) // 4 targets and L1's tile as coverage
    let drawn = resolveFrame(state, IDENTITY, 512, 512).drawn
    expect(drawn).toEqual(first.tiles) // all resident: no coarser layer
    for (let i = 0; i < 10; i++) {
      const frame = resolveFrame(state, IDENTITY, 512, 512)
      expect(frame.drawn).toBe(drawn)
      drawn = frame.drawn
    }
    expect(slide.stats.requested).toBe(requested)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })

  test('draws resident coarser tiles under missing targets, identity-stable', async () => {
    const levels = [pyramidLevel(0, 1, 2, 2), pyramidLevel(1, 2, 1, 1)]
    const { slide, source } = makeSlide(levels, 512, 512)
    const state = planeState(slide)
    // Zoomed out, L1 loads and becomes resident.
    const half = new Float32Array(IDENTITY)
    half[0] = half[5] = 0.5
    expect(resolveFrame(state, half, 512, 512).level.index).toBe(1)
    await waitFor(() => slide.pendingCount === 0)
    // Zoomed in, L0 is held back: drawn is L1 under the four targets.
    let release = () => {}
    source.gate = new Promise((resolve) => {
      release = resolve
    })
    const loading = resolveFrame(state, IDENTITY, 512, 512)
    const l1 = slide.manifest.levels[1] as NVSlideLevelManifest
    expect(loading.level.index).toBe(0)
    expect(loading.drawn.map((t) => t.level.index)).toEqual([1, 0, 0, 0, 0])
    expect(loading.drawn[0]?.key).toBe(slide.tileKey(l1, { x: 0, y: 0 }))
    expect(resolveFrame(state, IDENTITY, 512, 512).drawn).toBe(loading.drawn)
    release()
    await waitFor(() => slide.pendingCount === 0)
    const settled = resolveFrame(state, IDENTITY, 512, 512).drawn
    expect(settled.map((t) => t.level.index)).toEqual([0, 0, 0, 0])
    expect(resolveFrame(state, IDENTITY, 512, 512).drawn).toBe(settled)
    slide.dispose()
  })

  // 64 x 64 tiles of 256 px over 7 levels, a cache holding 20 tiles; 1000
  // frames pan across the whole plane while zooming between ~0.5 and ~1.5
  // device px per base px. Returns the largest wanted set seen and the cap.
  async function panFrames() {
    const levels = [64, 32, 16, 8, 4, 2, 1].map((n, i) =>
      pyramidLevel(i, 2 ** i, n, n),
    )
    const size = 64 * 256
    const maxCacheBytes = Math.ceil((20 * 256 * 256) / 0.75)
    const { slide } = makeSlide(levels, size, size, { maxCacheBytes })
    const l0 = slide.manifest.levels[0] as NVSlideLevelManifest
    const cap = tileCapacity(slide.manifest, l0, maxCacheBytes, undefined, {
      tileBytes: 128 * 1024 * 1024,
      rawPoolBytes: 32 * 1024 * 1024,
    }).tiles
    const wanted = (slide as unknown as { _wanted: Map<string, number> })
      ._wanted
    const state = planeState(slide)
    let max = 0
    for (let i = 0; i < 1000; i++) {
      const s = 16 * (1 + 0.5 * Math.sin(i / 37)) // the plane spans +-s in clip
      const mvp = new Float32Array(IDENTITY)
      mvp[0] = mvp[5] = s
      mvp[12] = -s * (-0.9 + (1.8 * i) / 999)
      mvp[13] = -s * 0.9 * Math.sin(i / 50)
      resolveFrame(state, mvp, 1024, 1024)
      max = Math.max(max, wanted.size)
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    releaseSlidePlane(state)
    expect(wanted.size).toBe(0)
    await waitFor(() => slide.pendingCount === 0) // aborts land as loads settle
    slide.dispose()
    return { max, cap }
  }

  test('a level over the plane capacity coarsens and says which it wanted', () => {
    const levels = [64, 32, 16, 8, 4, 2, 1].map((n, i) =>
      pyramidLevel(i, 2 ** i, n, n),
    )
    const size = 64 * 256
    const maxCacheBytes = Math.ceil((20 * 256 * 256) / 0.75)
    const { slide } = makeSlide(levels, size, size, { maxCacheBytes })
    const state = planeState(slide)
    state.levelIndex = 0 // L0 whole: 4096 tiles in view, cap 20
    const r = resolveFrame(state, IDENTITY, 1024, 1024)
    expect(r.requestedLevel?.index).toBe(0)
    expect(r.level.index).toBeGreaterThan(0)
    expect(r.tiles.length).toBeLessThanOrEqual(slide.planeCapacity(r.level))
    releaseSlidePlane(state)
    slide.dispose()
  })

  // R4: coverage fits in what the targets leave of planeCapacity.
  test('R4: 1000 3D-only pan frames keep _wanted within tileCapacity', async () => {
    const { max, cap } = await panFrames()
    expect(max).toBeLessThanOrEqual(cap)
  })

  test('a second RENDER viewport seeing the plane edge-on keeps the first one loads', () => {
    // One slot: the rest queue, so a cancel counts as aborted at once.
    const { slide, source } = makeSlide([pyramidLevel(0, 1, 2, 2)], 512, 512, {
      maxConcurrentLoads: 1,
    })
    source.gate = new Promise(() => {})
    const state = planeState(slide)
    const edgeOn = new Float32Array(IDENTITY)
    edgeOn[5] = 0 // the slide's y axis collapses: no area on screen
    for (let frame = 0; frame < 3; frame++) {
      beginSlidePlaneFrame(state)
      resolveSlidePlaneTiles(state, IDENTITY, 512, 512)
      resolveSlidePlaneTiles(state, edgeOn, 512, 256)
    }
    expect(slide.pendingCount).toBe(4)
    expect(slide.stats.aborted).toBe(0)
    releaseSlidePlane(state)
    slide.dispose()
  })

  test('releaseSlidePlane cancels what only the plane wanted', () => {
    const { slide, source } = makeSlide(
      [pyramidLevel(0, 1, 2, 2)],
      512,
      512,
      {},
    )
    source.gate = new Promise(() => {})
    const state = planeState(slide)
    resolveFrame(state, IDENTITY, 512, 512)
    expect(slide.pendingCount).toBe(4)
    releaseSlidePlane(state)
    expect([state.owners, state.coverOwners]).toEqual([undefined, undefined])
    expect(slide.pendingCount).toBe(4) // in flight until the source settles
    expect(slide.stats.aborted).toBe(0)
    slide.dispose()
  })
})

describe('slideExtentCorners', () => {
  test('returns the four slide-extent corners in world mm', () => {
    const m = unitTransform(512, 256)
    const [tl, tr, bl, br] = slideExtentCorners(m, 512, 256)
    expect(tl).toEqual([-1, -1, 0])
    expect(tr).toEqual([1, -1, 0])
    expect(bl).toEqual([-1, 1, 0])
    expect(br).toEqual([1, 1, 0])
  })
})

describe('pickSlidePixel', () => {
  const state = (): SlidePlaneState => ({
    slide: makeSlide([pyramidLevel(0, 1, 2, 2)], 512, 512).slide,
    pixelToWorld: unitTransform(512, 512),
    // IDENTITY mvp + 100x100 viewport: slide center -> canvas (50,50).
    pickFrames: [{ mvp: IDENTITY, ltwh: [0, 0, 100, 100], bx: 0, by: 0 }],
  })

  test('maps the canvas center to the slide center', () => {
    const p = pickSlidePixel(state(), 50, 50)
    expect(p).not.toBeNull()
    expect(p?.x).toBeCloseTo(256, 5)
    expect(p?.y).toBeCloseTo(256, 5)
  })

  test('round-trips a known corner (bottom-left of the plane)', () => {
    // slide (0,512) -> world/ndc (-1,1) -> canvas (0,0) (y flipped).
    const p = pickSlidePixel(state(), 0, 0)
    expect(p?.x).toBeCloseTo(0, 4)
    expect(p?.y).toBeCloseTo(512, 4)
  })

  test('returns null off the plane and when no frame was captured', () => {
    expect(pickSlidePixel(state(), 200, 200)).toBeNull()
    const noFrame = state()
    noFrame.pickFrames = []
    expect(pickSlidePixel(noFrame, 50, 50)).toBeNull()
  })

  test('picks with the camera of the render tile under the point', () => {
    // Two side-by-side tiles; the right one shows the plane at half scale.
    const s = state()
    const half = [...IDENTITY]
    half[0] = half[5] = 0.5
    s.pickFrames?.push({
      mvp: new Float32Array(half),
      ltwh: [100, 0, 100, 100],
      bx: 0,
      by: 0,
    })
    // Right tile: centre -> slide centre, a quarter tile right -> right edge.
    expect(pickSlidePixel(s, 150, 50)?.x).toBeCloseTo(256, 4)
    expect(pickSlidePixel(s, 175, 50)?.x).toBeCloseTo(512, 4)
    expect(pickSlidePixel(s, 25, 50)?.x).toBeCloseTo(128, 4)
    // Outside every tile rect.
    expect(pickSlidePixel(s, 50, 150)).toBeNull()
  })

  test('a shared tile edge picks with the right tile, as hitTest does', () => {
    const s = state()
    s.pickFrames?.push({
      mvp: IDENTITY,
      ltwh: [100, 0, 100, 100],
      bx: 0,
      by: 0,
    })
    // x=100 is the right tile's left edge (slide x 0), not the left's right edge.
    expect(pickSlidePixel(s, 100, 50)?.x).toBeCloseTo(0, 4)
  })

  test('pickSlideWorld returns the hit in world mm', () => {
    // canvas (75,25) -> ndc (0.5, 0.5) == world under IDENTITY.
    const mm = pickSlideWorld(state(), 75, 25)
    expect(mm?.[0]).toBeCloseTo(0.5, 5)
    expect(mm?.[1]).toBeCloseTo(0.5, 5)
    expect(mm?.[2]).toBeCloseTo(0, 5)
    expect(pickSlideWorld(state(), 200, 200)).toBeNull()
  })
})

describe('cornerQuad', () => {
  test('interleaves corners with top-left-origin UVs in strip order', () => {
    const quad = cornerQuad([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
    ])
    expect(Array.from(quad)).toEqual([
      0, 1, 2, 0, 0, 3, 4, 5, 1, 0, 6, 7, 8, 0, 1, 9, 10, 11, 1, 1,
    ])
  })
})
