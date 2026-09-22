import { describe, expect, test } from 'bun:test'
import {
  composePlaneVisibility,
  paqdEaseAlpha,
  paqdVoxelVisible,
  type RgbaGrid,
  rgbaGridOffset,
} from './planeVisibility'

// volumePaqdUniforms as [t0, t1, y1, y2]: zero alpha up to t0, rising to y1
// at the midpoint of [t0, t1], to y2 at t1, and flat beyond.
const EASE = [0.2, 0.6, 0.5, 1.0]

describe('paqdEaseAlpha', () => {
  test('is the shaders piecewise-linear ramp', () => {
    expect(paqdEaseAlpha(0.0, EASE)).toBe(0)
    expect(paqdEaseAlpha(0.2, EASE)).toBe(0)
    expect(paqdEaseAlpha(0.3, EASE)).toBeCloseTo(0.25, 12)
    expect(paqdEaseAlpha(0.4, EASE)).toBeCloseTo(0.5, 12)
    expect(paqdEaseAlpha(0.5, EASE)).toBeCloseTo(0.75, 12)
    expect(paqdEaseAlpha(0.6, EASE)).toBeCloseTo(1.0, 12)
    expect(paqdEaseAlpha(1.0, EASE)).toBe(1.0)
  })

  test('takes the magnitude of the two heights, as the shaders do', () => {
    expect(paqdEaseAlpha(1.0, [0.2, 0.6, -0.5, -1.0])).toBe(1.0)
    expect(paqdEaseAlpha(0.4, [0.2, 0.6, -0.5, -1.0])).toBeCloseTo(0.5, 12)
  })
})

describe('paqdVoxelVisible', () => {
  test('a voxel with no probability at all is not drawn', () => {
    expect(paqdVoxelVisible(0, 0, EASE)).toBe(false)
    // One byte is the shaders' 0.004 floor exactly, which is not above it.
    expect(paqdVoxelVisible(1, 0, EASE)).toBe(false)
  })

  test('a primary probability under the ease threshold is not drawn', () => {
    // 0.2 * 255 = 51: at or below t0 the eased alpha is zero.
    expect(paqdVoxelVisible(51, 0, EASE)).toBe(false)
    expect(paqdVoxelVisible(52, 0, EASE)).toBe(true)
  })

  test('secondary probability alone clears the floor but not the ease', () => {
    expect(paqdVoxelVisible(0, 200, EASE)).toBe(false)
  })
})

describe('rgbaGridOffset', () => {
  const grid: RgbaGrid = {
    data: new Uint8Array(2 * 3 * 4 * 4),
    dims: [2, 3, 4],
  }
  const lo = [0, 0, 0]
  const hi = [20, 30, 40]

  test('floors to the voxel the shaders texelFetch', () => {
    // Each voxel is 10 mm on every axis.
    expect(rgbaGridOffset(grid, lo, hi, 0, 0, 0)).toBe(0)
    expect(rgbaGridOffset(grid, lo, hi, 9.9, 0, 0)).toBe(0)
    expect(rgbaGridOffset(grid, lo, hi, 10, 0, 0)).toBe(4)
    expect(rgbaGridOffset(grid, lo, hi, 0, 10, 0)).toBe(2 * 4)
    expect(rgbaGridOffset(grid, lo, hi, 0, 0, 10)).toBe(2 * 3 * 4)
  })

  test('the far face clamps to the last voxel rather than running off', () => {
    expect(rgbaGridOffset(grid, lo, hi, 20, 30, 40)).toBe((2 * 3 * 4 - 1) * 4)
  })

  test('outside the box is -1', () => {
    expect(rgbaGridOffset(grid, lo, hi, -0.1, 0, 0)).toBe(-1)
    expect(rgbaGridOffset(grid, lo, hi, 0, 0, 40.1)).toBe(-1)
  })
})

describe('composePlaneVisibility', () => {
  const lo = [0, 0, 0]
  const hi = [10, 10, 10]
  // One voxel per 10 mm: the whole box is a single voxel.
  const one = (): RgbaGrid => ({ data: new Uint8Array(4), dims: [1, 1, 1] })
  const base = (x: number): number => (x > 5 ? 1 : 0)

  test('no base sampler means every crossing is visible, layers or not', () => {
    const drawing = one()
    drawing.data[3] = 255
    expect(
      composePlaneVisibility({ lo, hi, base: undefined, drawing }),
    ).toBeUndefined()
  })

  test('no layer returns the base sampler itself', () => {
    expect(composePlaneVisibility({ lo, hi, base })).toBe(base)
  })

  test('the base volume still wins where it is visible', () => {
    const s = composePlaneVisibility({ lo, hi, base, drawing: one() })
    expect(s?.(6, 1, 1)).toBe(1)
    expect(s?.(4, 1, 1)).toBe(0)
  })

  test('a painted drawing voxel makes transparent base pickable', () => {
    const drawing = one()
    drawing.data[3] = 1
    const s = composePlaneVisibility({ lo, hi, base, drawing })
    expect(s?.(4, 1, 1)).toBe(1)
  })

  test('an unpainted drawing voxel does not', () => {
    const drawing = one()
    drawing.data[0] = 255
    drawing.data[1] = 255
    drawing.data[2] = 255
    const s = composePlaneVisibility({ lo, hi, base, drawing })
    expect(s?.(4, 1, 1)).toBe(0)
  })

  test('a drawn PAQD label makes transparent base pickable', () => {
    const grid = one()
    grid.data[2] = 200
    const s = composePlaneVisibility({
      lo,
      hi,
      base,
      paqd: { grid, uniforms: EASE },
    })
    expect(s?.(4, 1, 1)).toBe(1)
  })

  test('a PAQD label the easing hides is not pickable', () => {
    const grid = one()
    grid.data[2] = 40
    const s = composePlaneVisibility({
      lo,
      hi,
      base,
      paqd: { grid, uniforms: EASE },
    })
    expect(s?.(4, 1, 1)).toBe(0)
  })

  test('outside the box nothing is visible', () => {
    const drawing = one()
    drawing.data[3] = 255
    const s = composePlaneVisibility({ lo, hi, base, drawing })
    expect(s?.(-1, 1, 1)).toBe(0)
  })
})
