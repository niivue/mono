import { describe, expect, test } from 'bun:test'

import type { NVSlideLevelManifest } from './NVSlide'
import { axialPlaneTransform, slidePlaneTiles } from './slidePlane'

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
