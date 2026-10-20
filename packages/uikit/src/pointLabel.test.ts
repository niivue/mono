import { describe, expect, it } from 'bun:test'
import { buildPointLabel } from './pointLabel'
import type { UIKitFontMetrics } from './text/font'

// One glyph 'A' that advances a full em, so a string of n A's measures n * size.
const FONT: UIKitFontMetrics = {
  distanceRange: 4,
  size: 32,
  textureSize: [64, 64],
  glyphs: new Map([['A', { plane: [0, 0, 1, 1], uv: [0, 0, 1, 1], xadv: 1 }]]),
}

const BOUNDS = { x: 0, y: 0, width: 400, height: 300 }

describe('buildPointLabel', () => {
  it('draws a diamond, a leader, an underline and one text item', () => {
    const g = buildPointLabel(FONT, {
      target: [100, 100],
      anchor: [160, 60],
      text: 'AA',
      sizePx: 20,
    })
    // 4 diamond edges, the leader, the underline.
    expect(g.lines).toHaveLength(4 + 1 + 1)
    expect(g.text).toHaveLength(1)
    expect(g.text[0]?.str).toBe('AA')
    expect(g.text[0]?.outlineWidthPx).toBe(2)
    expect(g.anchor).toEqual([160, 60])
  })

  it('runs the text away from the target, on the anchor side', () => {
    const right = buildPointLabel(FONT, {
      target: [100, 100],
      anchor: [160, 60],
      text: 'AA',
      sizePx: 20,
    })
    expect(right.text[0]?.align).toBe(0)
    expect(right.text[0]?.x).toBeGreaterThan(160)
    const left = buildPointLabel(FONT, {
      target: [100, 100],
      anchor: [40, 60],
      text: 'AA',
      sizePx: 20,
    })
    expect(left.text[0]?.align).toBe(1)
    expect(left.text[0]?.x).toBeLessThan(40)
  })

  it('places the automatic anchor away from the bounds centre', () => {
    // Target left of and above the centre (200,150): the anchor moves further
    // up-left along that direction, at the leader length.
    const g = buildPointLabel(FONT, {
      target: [140, 70],
      text: 'A',
      bounds: BOUNDS,
      leaderLength: 100,
    })
    const dx = g.anchor[0] - 140
    const dy = g.anchor[1] - 70
    expect(Math.hypot(dx, dy)).toBeCloseTo(100, 5)
    expect(dx / dy).toBeCloseTo(60 / 80, 5)
    expect(dx).toBeLessThan(0)
    expect(dy).toBeLessThan(0)
  })

  it('points up and to the right without bounds or when on the centre', () => {
    const noBounds = buildPointLabel(FONT, {
      target: [0, 0],
      text: 'A',
      leaderLength: 10,
    })
    expect(noBounds.anchor[0]).toBeCloseTo(Math.SQRT1_2 * 10, 5)
    expect(noBounds.anchor[1]).toBeCloseTo(-Math.SQRT1_2 * 10, 5)
    const centred = buildPointLabel(FONT, {
      target: [200, 150],
      text: 'A',
      bounds: BOUNDS,
      leaderLength: 10,
    })
    expect(centred.anchor[0] - 200).toBeCloseTo(noBounds.anchor[0], 5)
    expect(centred.anchor[1] - 150).toBeCloseTo(noBounds.anchor[1], 5)
  })

  it('flips the text to the other side when it would leave the frame', () => {
    // Anchor near the right edge with a 5-em string: rightward text would end
    // at 380 + 6 + 100, past width 400, so it runs leftward instead.
    const g = buildPointLabel(FONT, {
      target: [300, 100],
      anchor: [380, 60],
      text: 'AAAAA',
      sizePx: 20,
      bounds: BOUNDS,
    })
    expect(g.text[0]?.align).toBe(1)
    expect(g.text[0]?.x).toBeLessThan(380)
  })

  it('outlines a box with twelve edges between corners one bit apart', () => {
    const box: [number, number][] = []
    for (let c = 0; c < 8; c++) {
      box.push([c & 1 ? 20 : 0, (c & 2 ? 20 : 0) + (c & 4 ? 5 : 0)])
    }
    const g = buildPointLabel(FONT, {
      target: [10, 10],
      anchor: [40, 0],
      text: 'A',
      markerSize: 0,
      box,
      boxColor: [0, 1, 1, 1],
      boxThickness: 7,
    })
    // 12 box edges, the leader, the underline.
    expect(g.lines).toHaveLength(12 + 1 + 1)
    const edges = g.lines.slice(0, 12).map((l) => Array.from(l.data))
    // Corner 0 to corner 1 is the first edge, along x.
    expect(edges[0]?.slice(0, 4)).toEqual([0, 0, 20, 0])
    for (const e of edges) {
      expect(e[4]).toBe(7)
      expect(e.slice(8)).toEqual([0, 1, 1, 1])
    }
    // A box with the wrong number of corners is ignored.
    const bad = buildPointLabel(FONT, {
      target: [10, 10],
      anchor: [40, 0],
      text: 'A',
      markerSize: 0,
      box: box.slice(0, 4),
    })
    expect(bad.lines).toHaveLength(2)
  })

  it('scales every pixel size, given or default', () => {
    const one = buildPointLabel(FONT, { target: [0, 0], text: 'A' })
    const two = buildPointLabel(FONT, { target: [0, 0], text: 'A', scale: 2 })
    expect(two.text[0]?.sizePx).toBe((one.text[0]?.sizePx ?? 0) * 2)
    expect(two.text[0]?.outlineWidthPx).toBe(
      (one.text[0]?.outlineWidthPx ?? 0) * 2,
    )
    expect(two.lines[0]?.data[4]).toBe((one.lines[0]?.data[4] ?? 0) * 2)
    expect(Math.hypot(two.anchor[0], two.anchor[1])).toBeCloseTo(
      Math.hypot(one.anchor[0], one.anchor[1]) * 2,
      5,
    )
    const given = buildPointLabel(FONT, {
      target: [0, 0],
      text: 'A',
      sizePx: 10,
      thickness: 1,
      scale: 3,
    })
    expect(given.text[0]?.sizePx).toBe(30)
    expect(given.lines[0]?.data[4]).toBe(3)
  })

  it('skips the marker and leader when they are disabled or degenerate', () => {
    const g = buildPointLabel(FONT, {
      target: [50, 50],
      anchor: [50, 50],
      text: 'A',
      markerSize: 0,
    })
    expect(g.lines).toHaveLength(1) // underline only
  })
})
