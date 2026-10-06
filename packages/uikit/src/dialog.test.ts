import { describe, expect, it } from 'bun:test'
import {
  buildDialog,
  DEFAULT_DIALOG_STYLE,
  type DialogSpec,
  dialogContains,
  layoutDialog,
  scaleDialog,
  wrapText,
} from './dialog'
import type { UIKitFontMetrics } from './text/font'

// A stub font where every glyph is half an em wide and the cap height 0.7 em.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map(
    [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,'].map((ch) => [
      ch,
      GLYPH,
    ]),
  ),
}
const STYLE = DEFAULT_DIALOG_STYLE
const BOUNDS = { width: 800, height: 600 }
const BUTTONS = [
  { id: 'cancel', width: 76, height: 28 },
  { id: 'ok', width: 44, height: 28 },
]

describe('wrapText', () => {
  it('breaks at the last space that fits and keeps long words whole', () => {
    // 10 px glyphs: 'ab cd ef' is 80 px wide.
    expect(wrapText(METRICS, 'ab cd ef', 20, 55)).toEqual(['ab cd', 'ef'])
    expect(wrapText(METRICS, 'abcdefgh ij', 20, 30)).toEqual(['abcdefgh', 'ij'])
  })

  it('forces a break at a newline and keeps empty lines', () => {
    expect(wrapText(METRICS, 'ab\n\ncd', 20, 500)).toEqual(['ab', '', 'cd'])
  })
})

describe('layoutDialog', () => {
  const spec: DialogSpec = {
    id: 'd',
    title: 'Title',
    message: 'one two',
    contentHeight: 40,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'OK', role: 'default' },
    ],
  }

  it('stacks title, message, content and buttons and centers the panel', () => {
    const l = layoutDialog(spec, STYLE, METRICS, BUTTONS, BOUNDS)
    const titleCap = 0.7 * STYLE.titleSizePx
    const lineH = STYLE.textSizePx * STYLE.lineHeight
    const height = Math.ceil(
      STYLE.padding +
        titleCap +
        STYLE.gap +
        lineH +
        STYLE.gap +
        40 +
        STYLE.gap +
        28 +
        STYLE.padding,
    )
    expect(l.panel.width).toBe(STYLE.width)
    expect(l.panel.height).toBe(height)
    expect(l.panel.x).toBe(Math.round((800 - STYLE.width) / 2))
    expect(l.panel.y).toBe(Math.round((600 - height) / 2))
    const left = l.panel.x + STYLE.padding
    expect(l.title).toEqual({
      x: left,
      y: l.panel.y + STYLE.padding + titleCap,
    })
    expect(l.lines).toHaveLength(1)
    expect(l.lines[0].str).toBe('one two')
    expect(l.lines[0].x).toBe(left)
    expect(l.content.x).toBe(left)
    expect(l.content.width).toBe(STYLE.width - 2 * STYLE.padding)
    expect(l.content.height).toBe(40)
    expect(l.content.y).toBeCloseTo(
      l.panel.y + STYLE.padding + titleCap + STYLE.gap + lineH + STYLE.gap,
    )
  })

  it('right-aligns the buttons in order on the bottom row', () => {
    const l = layoutDialog(spec, STYLE, METRICS, BUTTONS, BOUNDS)
    const right = l.panel.x + STYLE.width - STYLE.padding
    expect(l.buttons.map((b) => b.id)).toEqual(['cancel', 'ok'])
    expect(l.buttons[1].box.x + 44).toBe(right)
    expect(l.buttons[0].box.x + 76 + STYLE.buttonGap).toBe(l.buttons[1].box.x)
    expect(l.buttons[0].box.y + 28 + STYLE.padding).toBe(
      l.panel.y + l.panel.height,
    )
  })

  it('wraps a long message to the panel width', () => {
    const l = layoutDialog(
      { id: 'd', message: 'aaaa bbbb cccc', width: 36 + 7 * 9 },
      STYLE,
      METRICS,
      [],
      BOUNDS,
    )
    // 14 px text: 7 px per glyph, 63 px per line fits 'aaaa bbbb' (63) exactly.
    expect(l.lines.map((x) => x.str)).toEqual(['aaaa bbbb', 'cccc'])
    expect(l.lines[1].y - l.lines[0].y).toBeCloseTo(14 * STYLE.lineHeight)
  })

  it('places the panel at the spec position and drops empty parts', () => {
    const l = layoutDialog(
      { id: 'd', x: 10, y: 20, title: 'T' },
      STYLE,
      METRICS,
      [],
      BOUNDS,
    )
    expect(l.panel.x).toBe(10)
    expect(l.panel.y).toBe(20)
    expect(l.panel.height).toBe(Math.ceil(2 * STYLE.padding + 0.7 * 18))
    expect(l.lines).toEqual([])
    expect(l.buttons).toEqual([])
    expect(l.content.height).toBe(0)
  })
})

describe('scaleDialog and dialogContains', () => {
  it('scales positions, sizes and style lengths', () => {
    const { spec, style } = scaleDialog(
      { id: 'd', x: 10, y: 20, width: 100, contentHeight: 30 },
      STYLE,
      2,
    )
    expect([spec.x, spec.y, spec.width, spec.contentHeight]).toEqual([
      20, 40, 200, 60,
    ])
    expect(style.padding).toBe(STYLE.padding * 2)
    expect(style.titleSizePx).toBe(STYLE.titleSizePx * 2)
    expect(style.lineHeight).toBe(STYLE.lineHeight)
    expect(scaleDialog({ id: 'd' }, STYLE, 2).spec.x).toBeUndefined()
  })

  it('hit-tests the panel only', () => {
    const l = layoutDialog(
      { id: 'd', x: 10, y: 20 },
      STYLE,
      METRICS,
      [],
      BOUNDS,
    )
    expect(dialogContains(l, 10, 20)).toBe(true)
    expect(dialogContains(l, 10 + STYLE.width, 20)).toBe(false)
    expect(dialogContains(l, 5, 25)).toBe(false)
  })
})

describe('buildDialog', () => {
  it('draws the scrim over the bounds, the panel, the title and each line', () => {
    const spec: DialogSpec = { id: 'd', title: 'Hello', message: 'a\n\nb' }
    const l = layoutDialog(spec, STYLE, METRICS, [], BOUNDS)
    const geo = buildDialog(spec, STYLE, l, BOUNDS)
    expect(geo.rects).toHaveLength(2)
    expect(Array.from(geo.rects[0].data.slice(0, 4))).toEqual([0, 0, 800, 600])
    expect(Array.from(geo.rects[1].data.slice(0, 4))).toEqual([
      l.panel.x,
      l.panel.y,
      l.panel.width,
      l.panel.height,
    ])
    // The empty middle line draws nothing.
    expect(geo.text.map((t) => t.str)).toEqual(['Hello', 'a', 'b'])
    expect(geo.text[0].sizePx).toBe(STYLE.titleSizePx)
    expect(geo.text[1].sizePx).toBe(STYLE.textSizePx)
  })
})
