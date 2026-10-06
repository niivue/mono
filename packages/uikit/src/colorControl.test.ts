import { describe, expect, it } from 'bun:test'
import {
  buildColorControl,
  type ColorControlSpec,
  colorControlContains,
  colorSwatchAt,
  colorsEqual,
  DEFAULT_COLOR_CONTROL_STYLE,
  layoutColorControl,
  scaleColorControl,
  selectedSwatch,
  withChannel,
} from './colorControl'
import type { UIKitFontMetrics } from './text/font'

// A stub font where every glyph is half an em wide and the cap height 0.7 em:
// 7 px per glyph and a 9.8 px cap height at the default 14 px.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'RGBAWColr '].map((ch) => [ch, GLYPH])),
}
const STYLE = DEFAULT_COLOR_CONTROL_STYLE
const PALETTE = [
  { name: 'red', color: [1, 0, 0, 1] as const },
  { name: 'green', color: [0, 1, 0, 1] as const },
  { name: 'blue', color: [0, 0, 1, 1] as const },
]
const SPEC: ColorControlSpec = {
  id: 'c',
  x: 10,
  y: 20,
  width: 220,
  value: [1, 0, 0, 1],
  palette: PALETTE,
}

describe('color helpers', () => {
  it('compares, replaces a channel with clamping, and finds the matching swatch', () => {
    expect(colorsEqual([1, 0, 0, 1], [1, 0, 0, 1])).toBe(true)
    expect(colorsEqual([1, 0, 0, 1], [1, 0, 0.1, 1])).toBe(false)
    expect(withChannel([1, 0, 0, 1], 'g', 0.5)).toEqual([1, 0.5, 0, 1])
    expect(withChannel([1, 0, 0, 1], 'a', 2)).toEqual([1, 0, 0, 1])
    expect(withChannel([1, 0, 0, 1], 'r', -1)).toEqual([0, 0, 0, 1])
    expect(selectedSwatch(PALETTE, [0, 1, 0, 1])).toBe(1)
    expect(selectedSwatch(PALETTE, [0.5, 1, 0, 1])).toBe(-1)
    expect(selectedSwatch(undefined, [1, 0, 0, 1])).toBe(-1)
  })
})

describe('layoutColorControl', () => {
  it('puts the preview left, three channel rows right and the palette below', () => {
    const l = layoutColorControl(SPEC, STYLE, METRICS)
    expect(l.labelBaseline).toBeNull()
    expect(l.preview).toEqual({ x: 10, y: 20, width: 48, height: 48 })
    expect(l.channels.map((c) => c.channel)).toEqual(['r', 'g', 'b'])
    // preview 48 + gap 10 + letter 7 + gap 10 = 75 from the left edge.
    expect(l.channels[0].letterX).toBe(68)
    expect(l.channels[0].slider).toEqual({
      x: 85,
      y: 20,
      width: 145,
      height: 12,
    })
    expect(l.channels[1].slider.y).toBe(20 + 12 + STYLE.channelGap)
    expect(l.channels[0].baseline).toBeCloseTo(20 + 6 + 4.9)
    // The block is the preview's 48 tall (taller than 3 rows), then the palette.
    expect(l.swatches).toHaveLength(3)
    expect(l.swatches[0]).toEqual({
      x: 10,
      y: 20 + 48 + STYLE.paletteGap,
      width: 18,
      height: 18,
    })
    expect(l.swatches[1].x).toBe(10 + 18 + STYLE.swatchGap)
    expect(l.height).toBe(48 + STYLE.paletteGap + 18)
    expect(l.width).toBe(220)
  })

  it('adds a label row and an alpha row, and wraps a long palette', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `${i}`,
      color: [i / 12, 0, 0, 1] as const,
    }))
    const l = layoutColorControl(
      { ...SPEC, label: 'Color', alpha: true, palette: many, width: 100 },
      STYLE,
      METRICS,
    )
    expect(l.labelBaseline).toBeCloseTo(20 + 9.8)
    const blockTop = 20 + 9.8 + STYLE.labelGap
    expect(l.preview.y).toBeCloseTo(blockTop)
    expect(l.channels.map((c) => c.channel)).toEqual(['r', 'g', 'b', 'a'])
    // 4 rows of 12 plus 3 gaps of 2 is 54: taller than the preview.
    expect(l.swatches[0].y).toBeCloseTo(blockTop + 54 + STYLE.paletteGap)
    // 100 px fits four 18 px swatches with 4 px gaps (84 px), not five.
    expect(l.swatches[4].x).toBe(10)
    expect(l.swatches[4].y).toBeCloseTo(l.swatches[0].y + 18 + STYLE.swatchGap)
    expect(l.swatches[11].y).toBeCloseTo(
      l.swatches[0].y + 2 * (18 + STYLE.swatchGap),
    )
  })

  it('scales positions, sizes and the slider overrides', () => {
    const { spec, style } = scaleColorControl(SPEC, STYLE, 2)
    expect([spec.x, spec.y, spec.width]).toEqual([20, 40, 440])
    expect(style.previewSize).toBe(96)
    expect(style.slider.thumbSize).toBe(24)
    expect(style.slider.trackHeight).toBe(10)
    expect(scaleColorControl(SPEC, STYLE, 1).spec).toBe(SPEC)
  })

  it('hit-tests the swatches and the whole control', () => {
    const l = layoutColorControl(SPEC, STYLE, METRICS)
    const row = l.swatches[0].y
    expect(colorSwatchAt(l, 15, row + 5)).toBe(0)
    expect(colorSwatchAt(l, 10 + 22 + 5, row + 5)).toBe(1)
    expect(colorSwatchAt(l, 10 + 19, row + 5)).toBe(-1)
    expect(colorSwatchAt(l, 15, 25)).toBe(-1)
    expect(colorControlContains(l, 15, 25)).toBe(true)
    expect(colorControlContains(l, 5, 25)).toBe(false)
  })
})

describe('buildColorControl', () => {
  it('draws the backdrop and preview, the letters and the swatches with rings', () => {
    const spec = { ...SPEC, label: 'Color' }
    const l = layoutColorControl(spec, STYLE, METRICS)
    const geo = buildColorControl(spec, STYLE, l, {
      value: [1, 0, 0, 1],
      hoverSwatch: 2,
      enabled: true,
    })
    expect(geo.text.map((t) => t.str)).toEqual(['Color', 'R', 'G', 'B'])
    expect(geo.text[0].outlineWidthPx).toBe(1)
    // backdrop, preview, then per swatch: a ring for the selected (0) and the
    // hovered (2), and the swatch itself.
    expect(geo.rects).toHaveLength(2 + 3 + 2)
    expect(Array.from(geo.rects[1].data.slice(8, 12))).toEqual([1, 0, 0, 1])
  })

  it('dims a disabled control and draws no hover ring', () => {
    const l = layoutColorControl(SPEC, STYLE, METRICS)
    const geo = buildColorControl(SPEC, STYLE, l, {
      value: [0, 0, 1, 1],
      hoverSwatch: 0,
      enabled: false,
    })
    expect(geo.rects).toHaveLength(2 + 3 + 1)
    expect(geo.rects[1].data[11]).toBeCloseTo(0.5)
    expect(geo.text[0].color).toEqual(STYLE.disabledTextColor)
  })
})
