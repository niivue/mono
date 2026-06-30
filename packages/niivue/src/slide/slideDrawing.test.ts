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
})
