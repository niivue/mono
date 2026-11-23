import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './text/font'
import {
  buildToolPalette,
  glyphOn,
  layoutToolPalette,
  DEFAULT_TOOL_PALETTE_STYLE as STYLE,
  scaleToolPaletteStyle,
  type ToolPaletteSpec,
  toolPaletteContains,
  toolPaletteItemAt,
  toolPaletteReach,
} from './toolPalette'

const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map(),
}

const SPEC: ToolPaletteSpec = {
  x: 0,
  y: 0,
  actions: [{ id: 'undo', label: 'Undo', icon: 'undo', enabled: false }],
  tools: [
    { id: 'pen', label: 'Pen', look: 'pen' },
    { id: 'fill', label: 'Fill', look: 'marker' },
    { id: 'wand', label: 'Wand', look: 'wand' },
    { id: 'eraser', label: 'Erase', look: 'eraser' },
  ],
  tool: 'pen',
  colors: ['r', 'g', 'b'].map((id) => ({ id, label: id, color: [1, 0, 0, 1] })),
  color: 'g',
  widths: ['1', '3', '7'].map((id) => ({ id, label: id })),
  width: '3',
}
const centre = (i: { x: number; y: number; width: number; height: number }) =>
  [i.x + i.width / 2, i.y + i.height / 2] as const

describe('tool palette', () => {
  it('lays the sections out in one row, left to right, inside the tray', () => {
    const layout = layoutToolPalette(SPEC, 10, 200, 1e9, STYLE, METRICS)
    expect(layout.height).toBe(STYLE.rowHeight)
    expect(layout.items.map((item) => item.kind)).toEqual([
      'action',
      ...Array(4).fill('tool'),
      ...Array(3).fill('color'),
      ...Array(3).fill('width'),
    ])
    expect(layout.dividers).toHaveLength(3)
    for (let i = 1; i < layout.items.length; i++) {
      const [a, b] = [layout.items[i - 1], layout.items[i]]
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.width)
    }
    const last = layout.items[layout.items.length - 1]
    expect(last.x + last.width + STYLE.padding).toBeCloseTo(10 + layout.width)
    // Tools reach above the tray, and can be pressed there.
    const pen = layout.items[1]
    expect(pen.y).toBe(200 - toolPaletteReach(STYLE, SPEC.tools))
    expect(toolPaletteContains(layout, pen.x + 1, pen.y + 1)).toBe(true)
    expect(toolPaletteContains(layout, 5, 205)).toBe(false)
  })

  it('wraps the last section that overflows onto a second row', () => {
    const one = layoutToolPalette(SPEC, 0, 0, 1e9, STYLE, METRICS)
    const two = layoutToolPalette(SPEC, 0, 0, one.width - 1, STYLE, METRICS)
    expect(two.height).toBe(2 * STYLE.rowHeight)
    expect(two.width).toBeLessThan(one.width)
    const kindY = (kind: string) => two.items.find((i) => i.kind === kind)?.y
    expect(kindY('color')).toBe(0)
    expect(kindY('width')).toBe(STYLE.rowHeight)
  })

  it('finds enabled items only', () => {
    const layout = layoutToolPalette(SPEC, 0, 0, 1e9, STYLE, METRICS)
    expect(toolPaletteItemAt(layout, ...centre(layout.items[0]))).toBe(-1)
    expect(toolPaletteItemAt(layout, ...centre(layout.items[5]))).toBe(5)
  })

  it('scales swatch, width and ring sizes with the style', () => {
    const sizes = (k: number) => {
      const style = scaleToolPaletteStyle(STYLE, k)
      const layout = layoutToolPalette(SPEC, 0, 100, 1e9, style, METRICS)
      const slot = (kind: string) =>
        layout.items.find((i) => i.kind === kind)?.width ?? 0
      // The selected swatch's ring is the widest round rect drawn for colors.
      const rects = buildToolPalette(SPEC, style, METRICS, layout, -1).rects
      const ring = Math.max(
        ...rects
          .map((r) => r.data)
          .filter((d) => d[2] === d[3] && d[2] < style.rowHeight)
          .map((d) => d[2]),
      )
      return [slot('color'), slot('width'), ring]
    }
    const [one, two] = [sizes(1), sizes(2)]
    for (const [i, v] of two.entries()) expect(v).toBeCloseTo(2 * one[i], 4)
  })

  it('puts tools that do not fit beside the actions on a row of their own above them', () => {
    const spec: ToolPaletteSpec = {
      x: 0,
      y: 0,
      actions: [{ id: 'undo', label: 'Undo', icon: 'undo' }],
      tools: [
        { id: 'pen', label: 'Pen', look: 'pen' },
        { id: 'eraser', label: 'Erase', look: 'eraser' },
      ],
      tool: 'pen',
    }
    const layout = layoutToolPalette(spec, 0, 100, 120, STYLE, METRICS)
    expect(layout.width).toBeLessThanOrEqual(120)
    expect(layout.height).toBe(2 * STYLE.rowHeight)
    const tool = layout.items.find((i) => i.kind === 'tool')
    const action = layout.items.find((i) => i.kind === 'action')
    expect(tool?.y).toBe(100 - toolPaletteReach(STYLE, spec.tools))
    expect(action?.y).toBe(100 + STYLE.rowHeight)
  })

  it('picks a key glyph that stands out on any ink', () => {
    const dark = STYLE.fill.slice(0, 3)
    const light = STYLE.textColor.slice(0, 3)
    expect(glyphOn([1, 0.9, 0.2, 1], STYLE).slice(0, 3)).toEqual(dark)
    expect(glyphOn([1, 0.23, 0.19, 1], STYLE).slice(0, 3)).toEqual(dark)
    expect(glyphOn([0, 0, 0, 1], STYLE).slice(0, 3)).toEqual(light)
    expect(glyphOn([0.1, 0.1, 0.5, 1], STYLE).slice(0, 3)).toEqual(light)
    // Faint yellow mostly shows the dark tray: a light glyph.
    expect(glyphOn([1, 0.9, 0.2, 0.1], STYLE).slice(0, 3)).toEqual(light)
  })

  it('draws the ellipse key as an ellipse, not a capsule', () => {
    const spec: ToolPaletteSpec = {
      x: 0,
      y: 100,
      actions: [],
      tools: [{ id: 'ellipse', label: 'Ellipse', look: 'ellipse' }],
      tool: '',
      colors: [],
    }
    const layout = layoutToolPalette(spec, 0, 100, 1e9, STYLE, METRICS)
    const { lines } = buildToolPalette(spec, STYLE, METRICS, layout, -1)
    const xs = lines.map((l) => l.data[0])
    const ys = lines.map((l) => l.data[1])
    const [cx, rx] = [
      (Math.max(...xs) + Math.min(...xs)) / 2,
      (Math.max(...xs) - Math.min(...xs)) / 2,
    ]
    const [cy, ry] = [
      (Math.max(...ys) + Math.min(...ys)) / 2,
      (Math.max(...ys) - Math.min(...ys)) / 2,
    ]
    expect(lines.length).toBeGreaterThan(12)
    for (const [x, y] of xs.map((x, k) => [x, ys[k]])) {
      expect(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2).toBeCloseTo(1, 1)
    }
  })

  it('keeps a key in the tray beside upright tools', () => {
    const spec: ToolPaletteSpec = {
      x: 0,
      y: 100,
      actions: [],
      tools: [
        { id: 'pen', label: 'Pen', look: 'pen' },
        { id: 'rectangle', label: 'Rect', look: 'rectangle' },
      ],
      tool: 'pen',
      colors: [],
    }
    const layout = layoutToolPalette(spec, 0, 100, 1e9, STYLE, METRICS)
    const [pen, key] = layout.items
    expect(pen.y).toBe(100 - toolPaletteReach(STYLE, spec.tools))
    expect(key.y).toBe(100)
    expect(key.height).toBe(STYLE.rowHeight)
    expect(toolPaletteContains(layout, key.x + 1, 99)).toBe(false)
  })

  it('draws shapes as flat keys, the picked one filled with the ink, and mirrors undo for redo', () => {
    const looks = [
      'freehand',
      'rectangle',
      'ellipse',
      'arrow',
      'spline',
      'livewire',
    ] as const
    const ink: [number, number, number, number] = [0, 0.5, 1, 1]
    const spec: ToolPaletteSpec = {
      x: 0,
      y: 100,
      actions: [
        { id: 'undo', label: 'Undo', icon: 'undo' },
        { id: 'redo', label: 'Redo', icon: 'redo' },
      ],
      tools: looks.map((look) => ({ id: look, label: look, look })),
      tool: 'arrow',
      colors: [{ id: 'blue', label: 'Blue', color: ink }],
      color: 'blue',
    }
    const layout = layoutToolPalette(spec, 0, 100, 1e9, STYLE, METRICS)
    const geometry = buildToolPalette(spec, STYLE, METRICS, layout, -1)
    expect(toolPaletteReach(STYLE, spec.tools)).toBe(0)
    const inked = (d: Float32Array, at: number) =>
      [...d.slice(at, at + 4)].every((v, k) => Math.abs(v - ink[k]) < 1e-6)
    for (const item of layout.items.filter((i) => i.kind === 'tool')) {
      expect(item.y).toBe(100)
      const inSlot = (x: number) => x >= item.x && x <= item.x + item.width
      const keyFills = geometry.rects.filter(
        (r) => inked(r.data, 8) && inSlot(r.data[0]),
      ).length
      expect(keyFills).toBe(item.id === 'arrow' ? 1 : 0)
      // A glyph beside the key: line strokes, or an outline rect.
      const marks =
        geometry.lines.filter((l) => inSlot(l.data[0])).length +
        geometry.rects.filter((r) => inSlot(r.data[0])).length
      expect(marks).toBeGreaterThan(1)
    }
    const [undo, redo] = layout.items
    const strokes = (item: { x: number; width: number }) =>
      geometry.lines
        .map((l) => l.data)
        .filter(
          (d) => d[0] >= item.x && d[0] <= item.x + item.width && d[1] >= 100,
        )
        .map((d) => [d[0] - item.x, d[2] - item.x])
    const mirrored = strokes(redo).map(([a, b]) => [
      undo.width - a,
      undo.width - b,
    ])
    expect(mirrored).toHaveLength(strokes(undo).length)
    for (const [i, [a, b]] of strokes(undo).entries()) {
      expect(mirrored[i][0]).toBeCloseTo(a, 4)
      expect(mirrored[i][1]).toBeCloseTo(b, 4)
    }
  })
})
