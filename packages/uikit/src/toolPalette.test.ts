import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './text/font'
import {
  buildToolPalette,
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
    expect(pen.y).toBe(200 - toolPaletteReach(STYLE))
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

  it('gives each section its own row when even two are too wide', () => {
    const narrow = layoutToolPalette(SPEC, 0, 0, 1, STYLE, METRICS)
    // Tools take the first row alone; the actions drop below them.
    expect(narrow.height).toBe(4 * STYLE.rowHeight)
    expect(narrow.dividers).toHaveLength(0)
    expect(narrow.items.filter((i) => i.kind === 'tool')[0].y).toBe(
      -toolPaletteReach(STYLE),
    )
  })

  it('keeps every tool pressable when the sections wrap', () => {
    const spec: ToolPaletteSpec = {
      ...SPEC,
      actions: ['undo', 'redo', 'clear'].map((id) => ({ id, label: id })),
    }
    const layout = layoutToolPalette(spec, 0, 100, 200, STYLE, METRICS)
    layout.items.forEach((item, i) => {
      // Near the raised tip, where a wrapped tool would sit over the row above.
      if (item.kind === 'tool')
        expect(
          toolPaletteItemAt(spec, layout, centre(item)[0], item.y + 2),
        ).toBe(i)
    })
  })

  it('finds enabled items only', () => {
    const layout = layoutToolPalette(SPEC, 0, 0, 1e9, STYLE, METRICS)
    expect(toolPaletteItemAt(SPEC, layout, ...centre(layout.items[0]))).toBe(-1)
    expect(toolPaletteItemAt(SPEC, layout, ...centre(layout.items[5]))).toBe(5)
  })

  it('raises the selected tool and rings the selected color', () => {
    const layout = layoutToolPalette(SPEC, 0, 100, 1e9, STYLE, METRICS)
    const tops = (spec: ToolPaletteSpec) =>
      buildToolPalette(spec, STYLE, METRICS, layout, -1).rects.length
    // A selected swatch adds one ring; a selected width adds its backing.
    expect(tops(SPEC)).toBe(tops({ ...SPEC, color: 'x', width: 'x' }) + 2)
    const geometry = buildToolPalette(SPEC, STYLE, METRICS, layout, -1)
    expect(geometry.text.map((t) => t.str)).toEqual([
      'Pen',
      'Fill',
      'Wand',
      'Erase',
    ])
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
    expect(tool?.y).toBe(100 - toolPaletteReach(STYLE))
    expect(action?.y).toBe(100 + STYLE.rowHeight)
  })
})
