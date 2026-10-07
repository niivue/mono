import { describe, expect, it } from 'bun:test'
import { buildRect, FLOATS_PER_RECT, rectContains } from './rect'

describe('buildRect', () => {
  it('packs the record in the shared wire layout', () => {
    const r = buildRect({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      radius: 6,
      borderWidth: 2,
      fill: [0.1, 0.2, 0.3, 0.4],
      border: [0.5, 0.6, 0.7, 0.8],
    })
    expect(r.data).toHaveLength(FLOATS_PER_RECT)
    expect([...r.data.slice(0, 6)]).toEqual([10, 20, 100, 40, 6, 2])
    expect([...r.data.slice(6, 8)]).toEqual([0, 0])
    expect([...r.data.slice(8, 12)].map((v) => +v.toFixed(3))).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ])
    expect([...r.data.slice(12, 16)].map((v) => +v.toFixed(3))).toEqual([
      0.5, 0.6, 0.7, 0.8,
    ])
  })

  it('clamps the corner radius to half the shorter side', () => {
    const r = buildRect({ x: 0, y: 0, width: 100, height: 20, radius: 50 })
    expect(r.data[4]).toBe(10)
  })

  it('defaults the border color to the fill and the widths to zero', () => {
    const r = buildRect({ x: 0, y: 0, width: 1, height: 1, fill: [1, 0, 0, 1] })
    expect([...r.data.slice(12, 16)]).toEqual([1, 0, 0, 1])
    expect(r.data[4]).toBe(0)
    expect(r.data[5]).toBe(0)
  })
})

describe('rectContains', () => {
  const box = { x: 10, y: 10, width: 20, height: 10 }
  it('is inclusive at the near edge and exclusive at the far edge', () => {
    expect(rectContains(box, 10, 10)).toBe(true)
    expect(rectContains(box, 29.9, 19.9)).toBe(true)
    expect(rectContains(box, 30, 15)).toBe(false)
    expect(rectContains(box, 15, 20)).toBe(false)
    expect(rectContains(box, 9, 15)).toBe(false)
  })
})
