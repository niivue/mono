import { describe, expect, test } from 'bun:test'

import { SlideDrawing } from './slideDrawing'

const at = (d: SlideDrawing, x: number, y: number): number =>
  d.img[y * d.width + x]
const countNonZero = (d: SlideDrawing): number =>
  d.img.reduce((n, v) => n + (v ? 1 : 0), 0)

describe('SlideDrawing', () => {
  test('allocates a blank slide-space raster', () => {
    const d = new SlideDrawing(8, 4)
    expect(d.width).toBe(8)
    expect(d.height).toBe(4)
    expect(d.img.length).toBe(32)
    expect(countNonZero(d)).toBe(0)
    expect(d.version).toBe(0)
  })

  test('point() paints a single raster pixel and bumps version', () => {
    const d = new SlideDrawing(8, 4)
    d.point(2, 1, 5, 1, true)
    expect(at(d, 2, 1)).toBe(5)
    expect(countNonZero(d)).toBe(1)
    expect(d.version).toBe(1)
  })

  test('point + line paint a connected run (line draws toward ptB)', () => {
    const d = new SlideDrawing(8, 4)
    // Real usage: the first point is painted on pen-down, then lines connect.
    d.point(0, 0, 3, 1, true)
    d.line(0, 0, 7, 0, 3, 1, true)
    for (let x = 0; x < 8; x++) expect(at(d, x, 0)).toBe(3)
    expect(at(d, 0, 1)).toBe(0) // adjacent row untouched
  })

  test('penValue 0 erases (eraser path)', () => {
    const d = new SlideDrawing(8, 4)
    d.point(2, 1, 7, 1, true)
    d.point(2, 1, 0, 1, true)
    expect(at(d, 2, 1)).toBe(0)
  })

  test('undo restores the pre-stroke raster', () => {
    const d = new SlideDrawing(8, 4)
    d.beginStroke() // snapshot empty
    d.point(2, 1, 5, 1, true)
    d.line(2, 1, 5, 1, 5, 1, true)
    expect(countNonZero(d)).toBeGreaterThan(0)
    expect(d.undo()).toBe(true)
    expect(countNonZero(d)).toBe(0)
  })

  test('undo returns false when there is nothing to undo', () => {
    const d = new SlideDrawing(8, 4)
    expect(d.undo()).toBe(false)
  })

  test('clear wipes the raster and bumps version', () => {
    const d = new SlideDrawing(8, 4)
    d.point(0, 0, 9, 1, true)
    const v = d.version
    d.clear()
    expect(countNonZero(d)).toBe(0)
    expect(d.version).toBe(v + 1)
  })

  test('bucketFill floods the whole empty raster from a seed', () => {
    const d = new SlideDrawing(8, 4)
    d.bucketFill(2, 1, 5, true)
    expect(countNonZero(d)).toBe(32)
    expect(at(d, 0, 0)).toBe(5)
    expect(at(d, 7, 3)).toBe(5)
  })

  test('bucketFill is bounded by a drawn divider', () => {
    const d = new SlideDrawing(8, 4)
    // Vertical divider at x=4 (label 9) splits the raster.
    for (let y = 0; y < 4; y++) d.point(4, y, 9, 1, true)
    d.bucketFill(0, 0, 5, true) // seed in the left region
    expect(at(d, 0, 0)).toBe(5)
    expect(at(d, 3, 2)).toBe(5) // left region filled
    expect(at(d, 4, 2)).toBe(9) // divider preserved
    expect(at(d, 5, 2)).toBe(0) // right region untouched
  })

  test('fillPen fills the interior of a closed outline', () => {
    const d = new SlideDrawing(16, 16)
    // Outline a box; drawPenFilled closes it and fills the inside.
    const ok = d.fillPen(
      [
        [3, 3],
        [12, 3],
        [12, 12],
        [3, 12],
      ],
      4,
      true,
    )
    expect(ok).toBe(true)
    expect(at(d, 7, 7)).toBe(4) // interior filled
    expect(at(d, 0, 0)).toBe(0) // outside untouched
  })

  test('fillPen needs at least two points', () => {
    const d = new SlideDrawing(8, 8)
    expect(d.fillPen([[1, 1]], 4, true)).toBe(false)
  })

  test('magicWand selects the connected same-color region within tolerance', () => {
    // 4x2 reference: left half black, right half white.
    const w = 4
    const h = 2
    const ref = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const x = i % w
      const v = x < 2 ? 0 : 255
      ref[i * 4] = v
      ref[i * 4 + 1] = v
      ref[i * 4 + 2] = v
      ref[i * 4 + 3] = 255
    }
    const d = new SlideDrawing(w, h)
    const filled = d.magicWand(ref, 0, 0, 30, 7, true) // seed in the black half
    expect(filled).toBe(4) // both black pixels in each row = 2x2
    expect(at(d, 0, 0)).toBe(7)
    expect(at(d, 1, 1)).toBe(7)
    expect(at(d, 2, 0)).toBe(0) // white half not selected
    expect(at(d, 3, 1)).toBe(0)
  })

  test('magicWand tolerance can bridge similar colors', () => {
    const w = 2
    const h = 1
    const ref = new Uint8ClampedArray([10, 10, 10, 255, 25, 25, 25, 255])
    const tight = new SlideDrawing(w, h)
    expect(tight.magicWand(ref, 0, 0, 5, 3, true)).toBe(1) // only the seed
    const loose = new SlideDrawing(w, h)
    expect(loose.magicWand(ref, 0, 0, 50, 3, true)).toBe(2) // both bridge
  })
})
