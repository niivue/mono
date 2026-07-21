import { describe, expect, it } from 'bun:test'
import { buildLine, buildTerminatedLine, LineTerminator } from './line'

// Decode a LineData record: [sx, sy, ex, ey, thickness, 0, 0, 0, r, g, b, a].
function seg(d: { data: Float32Array }) {
  return {
    sx: d.data[0],
    sy: d.data[1],
    ex: d.data[2],
    ey: d.data[3],
    thickness: d.data[4],
    color: Array.from(d.data.slice(8, 12)),
  }
}
const length = (s: ReturnType<typeof seg>) =>
  Math.hypot(s.ex - s.sx, s.ey - s.sy)

describe('buildTerminatedLine', () => {
  it('returns a single bare line equal to buildLine when there are no terminators', () => {
    const [only, ...rest] = buildTerminatedLine(0, 0, 100, 0, 3, [1, 0, 0, 1])
    expect(rest).toHaveLength(0)
    expect(Array.from(only.data)).toEqual(
      Array.from(buildLine(0, 0, 100, 0, 3, [1, 0, 0, 1]).data),
    )
  })

  it('adds two symmetric barbs sharing the tip for an end ARROW', () => {
    const out = buildTerminatedLine(0, 0, 100, 0, 2, [1, 0, 0, 1], {
      end: LineTerminator.ARROW,
    })
    expect(out).toHaveLength(3)
    const [shaft, b1, b2] = out.map(seg)

    expect(shaft.sx).toBeCloseTo(0)
    expect(shaft.ex).toBeCloseTo(96) // inset by arrowLen/2 = 4
    expect(shaft.ex).toBeLessThan(100)

    for (const b of [b1, b2]) {
      expect(b.sx).toBeCloseTo(100)
      expect(b.sy).toBeCloseTo(0)
      expect(length(b)).toBeCloseTo(8) // arrowLength(2)
    }
    expect(b1.ex).toBeCloseTo(b2.ex)
    expect(b1.ey).toBeCloseTo(-b2.ey)
    expect(b1.ey).not.toBeCloseTo(0)
    expect(b1.thickness).toBe(2)
    expect(b1.color).toEqual([1, 0, 0, 1])
  })

  it('mirrors the arrow at the start point for a start ARROW', () => {
    const out = buildTerminatedLine(0, 0, 100, 0, 2, [1, 0, 0, 1], {
      start: LineTerminator.ARROW,
    })
    expect(out).toHaveLength(3)
    const [shaft, b1, b2] = out.map(seg)
    expect(shaft.sx).toBeCloseTo(4)
    expect(shaft.ex).toBeCloseTo(100)
    for (const b of [b1, b2]) {
      expect(b.sx).toBeCloseTo(0)
      expect(b.sy).toBeCloseTo(0)
      expect(b.ex).toBeGreaterThan(0)
    }
  })

  it('decorates both ends -> five segments', () => {
    const out = buildTerminatedLine(0, 0, 100, 0, 2, [0, 1, 0, 1], {
      start: LineTerminator.ARROW,
      end: LineTerminator.ARROW,
    })
    expect(out).toHaveLength(5)
    const shaft = seg(out[0])
    expect(shaft.sx).toBeCloseTo(4)
    expect(shaft.ex).toBeCloseTo(96)
  })

  it('is direction-agnostic: barbs point back along the shaft on a diagonal', () => {
    const out = buildTerminatedLine(0, 0, 30, 40, 2, [1, 1, 1, 1], {
      end: LineTerminator.ARROW,
    })
    const [, b1, b2] = out.map(seg)
    const dot = (b: ReturnType<typeof seg>) =>
      (b.ex - b.sx) * 0.6 + (b.ey - b.sy) * 0.8
    expect(dot(b1)).toBeLessThan(0)
    expect(dot(b2)).toBeLessThan(0)
    expect(length(b1)).toBeCloseTo(length(b2))
  })

  it('returns the bare shaft for a zero-length line', () => {
    const out = buildTerminatedLine(5, 5, 5, 5, 2, [1, 0, 0, 1], {
      end: LineTerminator.ARROW,
    })
    expect(out).toHaveLength(1)
  })

  it('throws for reserved (unimplemented) terminators', () => {
    expect(() =>
      buildTerminatedLine(0, 0, 10, 0, 2, [1, 0, 0, 1], {
        end: LineTerminator.CIRCLE,
      }),
    ).toThrow(/not implemented/)
    expect(() =>
      buildTerminatedLine(0, 0, 10, 0, 2, [1, 0, 0, 1], {
        start: LineTerminator.RING,
      }),
    ).toThrow(/not implemented/)
  })
})
