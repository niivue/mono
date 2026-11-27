import { describe, expect, test } from 'bun:test'
import { parseFont, UBUNTU_FONT_METRICS as ubuntu } from '@niivue/uikit'
import { buildTextLayout, emptyBatch, panelRects } from './NVFont'

describe('panelRects', () => {
  test('keeps only visible panels; a ring keeps a transparent fill', () => {
    const hidden = emptyBatch()
    const ring = {
      ...emptyBatch(),
      backColor: [1, 0, 0, 0.8],
      backRect: [1, 2, 30, 40],
      backRadius: 3,
      backBorder: 2,
    }
    const rects = panelRects([hidden, ring])
    expect(rects).toHaveLength(1)
    const d = Array.from(rects[0]?.data ?? [])
    expect(d.slice(0, 6)).toEqual([1, 2, 30, 40, 3, 2])
    expect(d.slice(8, 16).map((v) => +v.toFixed(3))).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0.8,
    ])
  })
})

// uikit tests the fallback glyph; this checks core's layout draws it.
test('an ASCII-only font lays out ² (the fallback glyph), not nothing', () => {
  const ascii = ubuntu.glyphs.filter((g) => g.unicode < 127)
  const mets = parseFont({ ...ubuntu, glyphs: ascii })
  const layout = (s: string) =>
    buildTextLayout(s, 0, 0, 10, 1, mets, [1, 1, 1, 1], 0, 0, [0, 0, 0, 0])
  expect(layout('mm²').count).toBe(3)
})
