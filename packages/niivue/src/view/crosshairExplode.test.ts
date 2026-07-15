import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import type { NVImage } from '@/NVTypes'
import { chunkVolume } from '@/volume/chunking'
import {
  applyCrosshairOffset,
  crosshairExplodeOffset,
} from './crosshairExplode'

const IDENTITY_RAS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

// An 8x1x1 volume split into two 4-voxel blocks, exploded apart along x.
const explodedVolume = (): NVImage =>
  ({
    chunkPlan: chunkVolume([8, 1, 1], 4, [0, 0, 0]),
    chunkExplode: { enabled: true, scale: [2, 1, 1] as const },
    matRAS: IDENTITY_RAS,
  }) as unknown as NVImage

/** mm -> texture fraction for a volume occupying mm x in [0,8]. */
const mm2texFor = (originMM: number, extentMM: number): mat4 => {
  const m = mat4.create()
  mat4.scale(m, m, [1 / extentMM, 1, 1])
  mat4.translate(m, m, [-originMM, 0, 0])
  return m
}

describe('crosshairExplodeOffset', () => {
  test('returns no offset for a volume without a chunk plan', () => {
    const vol = { matRAS: IDENTITY_RAS } as unknown as NVImage
    expect(crosshairExplodeOffset(vol, [4, 0, 0], mat4.create())).toEqual([
      0, 0, 0,
    ])
  })

  test('returns no offset when the volume is undefined or mm2tex is null', () => {
    expect(crosshairExplodeOffset(undefined, [4, 0, 0], mat4.create())).toEqual(
      [0, 0, 0],
    )
    expect(crosshairExplodeOffset(explodedVolume(), [4, 0, 0], null)).toEqual([
      0, 0, 0,
    ])
  })

  test('shifts opposite ways for crosshairs in the two exploded blocks', () => {
    const vol = explodedVolume()
    const mm2tex = mm2texFor(0, 8)
    // mm x=2 is in the left block, x=6 in the right block.
    const left = crosshairExplodeOffset(vol, [2, 0, 0], mm2tex)
    const right = crosshairExplodeOffset(vol, [6, 0, 0], mm2tex)
    expect(left[0]).toBeLessThan(0)
    expect(right[0]).toBeGreaterThan(0)
    expect(left[0]).toBeCloseTo(-right[0], 6)
  })

  test('uses volume texture fraction, not scene fraction', () => {
    // The bug: passing scene fraction worked only when the scene AABB was exactly
    // the volume's extent. Give the scene twice the volume's extent (as an extra
    // mesh would), so the volume occupies mm x in [0,8] of a [0,16] scene.
    const vol = explodedVolume()
    const mm2tex = mm2texFor(0, 8)

    // A crosshair at mm x=6 sits in the volume's RIGHT block (tex frac 0.75).
    const off = crosshairExplodeOffset(vol, [6, 0, 0], mm2tex)
    expect(off[0]).toBeGreaterThan(0)

    // Its SCENE fraction is 6/16 = 0.375, which would have selected the LEFT
    // block and shifted the crosshair the wrong way. Reproduce that mistake by
    // feeding the scene fraction through an identity mm2tex.
    const sceneFracAsTexFrac = crosshairExplodeOffset(
      vol,
      [6 / 16, 0, 0],
      mat4.create(),
    )
    expect(sceneFracAsTexFrac[0]).toBeLessThan(0)
    expect(Math.sign(sceneFracAsTexFrac[0])).not.toBe(Math.sign(off[0]))
  })

  test('agrees with the annotation path: same mm -> same offset', () => {
    // The annotation path (view/NVAnnotation.ts) transforms anchor mm by mm2tex
    // and calls explodeOffsetMMAtFrac. The crosshair must land on the same block.
    const vol = explodedVolume()
    const mm2tex = mm2texFor(0, 8)
    for (const x of [0.5, 3.5, 4.5, 7.5]) {
      const off = crosshairExplodeOffset(vol, [x, 0, 0], mm2tex)
      // Left half shifts left, right half shifts right.
      expect(Math.sign(off[0])).toBe(x < 4 ? -1 : 1)
    }
  })

  test('a crosshair outside the volume gets no offset', () => {
    const vol = explodedVolume()
    const mm2tex = mm2texFor(0, 8)
    expect(crosshairExplodeOffset(vol, [-5, 0, 0], mm2tex)).toEqual([0, 0, 0])
    expect(crosshairExplodeOffset(vol, [99, 0, 0], mm2tex)).toEqual([0, 0, 0])
  })
})

describe('applyCrosshairOffset', () => {
  test('returns the input unchanged for a zero offset', () => {
    const p = new Float32Array([1, 2, 3])
    expect(applyCrosshairOffset(p, [0, 0, 0])).toBe(p)
  })

  test('translates by a non-zero offset', () => {
    const out = applyCrosshairOffset(new Float32Array([1, 2, 3]), [10, 0, -1])
    expect([out[0], out[1], out[2]]).toEqual([11, 2, 2])
  })
})
