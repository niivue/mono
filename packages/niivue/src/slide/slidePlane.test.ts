import { describe, expect, test } from 'bun:test'

import type { NVSlide, NVSlideLevelManifest } from './NVSlide'
import {
  axialPlaneTransform,
  pickSlidePixel,
  resolveSlidePlaneTiles,
  type SlidePlaneState,
  selectSlidePlaneLevel,
  slideExtentCorners,
  slidePlaneTiles,
} from './slidePlane'

// Column-major 4x4 identity: clip == world, so ndc == world (w = 1).
const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
])

// Minimal NVSlide stand-in: only manifest + requestTile are read by these fns.
function fakeSlide(
  levels: NVSlideLevelManifest[],
  width: number,
  height: number,
): { slide: NVSlide; requested: string[] } {
  const requested: string[] = []
  const slide = {
    manifest: { width, height, levels, tileSize: 256 },
    requestTile: (lvl: NVSlideLevelManifest, t: { x: number; y: number }) =>
      requested.push(`L${lvl.index}/${t.x}/${t.y}`),
  } as unknown as NVSlide
  return { slide, requested }
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
    codec: 'image/jpeg',
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
    codec: 'image/jpeg',
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
    const quads = slidePlaneTiles(level(), 256, 256, m)
    expect(quads).toHaveLength(2)
    // Identity-like transform (extents == pixels): corners == base pixels at z=0.
    expect(quads[0].key).toBe('L0/0/0')
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
    slide: fakeSlide(levels, 512, 512).slide,
    pixelToWorld: unitTransform(512, 512),
    levelIndex,
    tilesByLevel: new Map(),
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
})

describe('resolveSlidePlaneTiles', () => {
  test('requests and returns the on-screen tiles of the chosen level', () => {
    const levels = [pyramidLevel(0, 1, 2, 2)]
    const { slide, requested } = fakeSlide(levels, 512, 512)
    const state: SlidePlaneState = {
      slide,
      pixelToWorld: unitTransform(512, 512),
      tilesByLevel: new Map(),
    }
    const { level, tiles } = resolveSlidePlaneTiles(state, IDENTITY, 512, 512)
    expect(level.index).toBe(0)
    expect(tiles).toHaveLength(4) // whole plane on screen
    expect(requested).toHaveLength(4)
    // The per-level tile array is cached (stable identity across frames).
    const again = resolveSlidePlaneTiles(state, IDENTITY, 512, 512)
    expect(state.tilesByLevel.get(0)).toBeDefined()
    expect(again.tiles).toHaveLength(4)
  })

  test('culls every tile when the plane is off-screen', () => {
    const levels = [pyramidLevel(0, 1, 2, 2)]
    const { slide, requested } = fakeSlide(levels, 512, 512)
    const state: SlidePlaneState = {
      slide,
      pixelToWorld: unitTransform(512, 512),
      tilesByLevel: new Map(),
    }
    // Shove the plane far to the right in clip space (m[12] = +10).
    const off = new Float32Array(IDENTITY)
    off[12] = 10
    const { tiles } = resolveSlidePlaneTiles(state, off, 512, 512)
    expect(tiles).toHaveLength(0)
    expect(requested).toHaveLength(0)
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
    slide: fakeSlide([pyramidLevel(0, 1, 2, 2)], 512, 512).slide,
    pixelToWorld: unitTransform(512, 512),
    tilesByLevel: new Map(),
    // IDENTITY mvp + 100x100 viewport: slide center -> canvas (50,50).
    pickFrame: { mvp: IDENTITY, ltwh: [0, 0, 100, 100], bx: 0, by: 0 },
  })

  test('maps the canvas center to the slide center', () => {
    const p = pickSlidePixel(state(), 50, 50)
    expect(p).not.toBeNull()
    expect(p?.x).toBeCloseTo(256, 5)
    expect(p?.y).toBeCloseTo(256, 5)
  })

  test('round-trips a known corner (top-left of the plane)', () => {
    // slide (0,0) -> world/ndc (-1,-1) -> canvas (0,100) (y flipped).
    const p = pickSlidePixel(state(), 0, 100)
    expect(p?.x).toBeCloseTo(0, 4)
    expect(p?.y).toBeCloseTo(0, 4)
  })

  test('returns null off the plane and when no frame was captured', () => {
    expect(pickSlidePixel(state(), 200, 200)).toBeNull()
    const noFrame = state()
    noFrame.pickFrame = null
    expect(pickSlidePixel(noFrame, 50, 50)).toBeNull()
  })
})
