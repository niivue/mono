import { describe, expect, it } from 'bun:test'
import {
  buildFilePicker,
  DEFAULT_FILE_PICKER_STYLE,
  ellipsizeStart,
  type FilePickerSpec,
  filePickerContains,
  filePickerSummary,
  layoutFilePicker,
  scaleFilePicker,
} from './filePicker'
import type { UIKitFontMetrics } from './text/font'

// A stub font where every glyph is half an em wide and the cap height 0.7 em.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map(CHARS.map((ch) => [ch, GLYPH])),
}
const STYLE = DEFAULT_FILE_PICKER_STYLE
const SPEC: FilePickerSpec = { id: 'f', x: 10, y: 20 }

describe('layoutFilePicker', () => {
  it('sizes the button to its label and puts the readout after the gap', () => {
    const l = layoutFilePicker(SPEC, STYLE, METRICS)
    // "Choose file..." is 14 glyphs of 8 px at 16 px plus 2 x 14 padding;
    // the height is the 11.2 px cap plus 2 x 8 padding, rounded up.
    expect(l.button).toEqual({ x: 10, y: 20, width: 140, height: 28 })
    expect(l.textX).toBe(160)
    expect(l.readoutWidth).toBe(STYLE.readoutWidth)
    expect(l.width).toBe(310)
    expect(l.height).toBe(28)
    expect(l.baseline).toBeCloseTo(20 + 14 + 4.9, 6)
  })

  it('gives the readout whatever a fixed width leaves', () => {
    const l = layoutFilePicker({ ...SPEC, width: 200 }, STYLE, METRICS)
    expect(l.width).toBe(200)
    expect(l.readoutWidth).toBe(50)
    expect(
      layoutFilePicker({ ...SPEC, width: 100 }, STYLE, METRICS).readoutWidth,
    ).toBe(0)
  })

  it('scales the row, the readout and the button consistently', () => {
    const { spec, style } = scaleFilePicker(SPEC, STYLE, 2)
    const l = layoutFilePicker(spec, style, METRICS)
    expect(l.button).toEqual({ x: 20, y: 40, width: 280, height: 55 })
    expect(l.textX).toBe(320)
    expect(style.textSizePx).toBe(28)
    expect(style.button.textSizePx).toBe(32)
    expect(scaleFilePicker(SPEC, STYLE, 1).style).toBe(STYLE)
  })

  it('hits only the button', () => {
    const l = layoutFilePicker(SPEC, STYLE, METRICS)
    expect(filePickerContains(l, 50, 30)).toBe(true)
    expect(filePickerContains(l, 200, 30)).toBe(false)
  })
})

describe('filePickerSummary and ellipsizeStart', () => {
  it('names one file, counts several, else shows the placeholder', () => {
    expect(filePickerSummary([])).toBe('No file chosen')
    expect(filePickerSummary([], 'Pick one')).toBe('Pick one')
    expect(filePickerSummary(['a.nii'])).toBe('a.nii')
    expect(filePickerSummary(['a.nii', 'b.nii', 'c.nii'])).toBe('3 files')
  })

  it('keeps the tail of a long name behind leading dots', () => {
    const name = 'abcdefghijklmnopqrstuvwxyz.nii.gz'
    expect(ellipsizeStart(METRICS, name, 14, 400)).toBe(name)
    // 160 px holds the 21 px dots plus 19 glyphs of 7 px.
    expect(ellipsizeStart(METRICS, name, 14, 160)).toBe(
      '...opqrstuvwxyz.nii.gz',
    )
    expect(ellipsizeStart(METRICS, name, 14, 21)).toBe('...')
    expect(ellipsizeStart(METRICS, name, 14, 10)).toBe('')
  })
})

describe('buildFilePicker', () => {
  const layout = layoutFilePicker(SPEC, STYLE, METRICS)

  it('draws the placeholder dimmed, with a contrast halo', () => {
    const geo = buildFilePicker(SPEC, STYLE, layout, METRICS, {
      names: [],
      enabled: true,
    })
    expect(geo.text).toHaveLength(1)
    expect(geo.text[0]).toMatchObject({
      str: 'No file chosen',
      x: 160,
      sizePx: 14,
      color: STYLE.emptyTextColor,
      outlineWidthPx: 1,
    })
    expect(geo.text[0].y).toBeCloseTo(layout.baseline, 6)
  })

  it('draws a chosen name in the text color and trims it to the readout', () => {
    const geo = buildFilePicker(SPEC, STYLE, layout, METRICS, {
      names: ['abcdefghijklmnopqrstuvwxyz.nii.gz'],
      enabled: true,
    })
    expect(geo.text[0].str).toBe('...opqrstuvwxyz.nii.gz')
    expect(geo.text[0].color).toEqual(STYLE.textColor)
  })

  it('dims a disabled picker and draws nothing without room', () => {
    const geo = buildFilePicker(SPEC, STYLE, layout, METRICS, {
      names: ['a.nii'],
      enabled: false,
    })
    expect(geo.text[0].color).toEqual(STYLE.disabledTextColor)
    const narrow = layoutFilePicker({ ...SPEC, width: 150 }, STYLE, METRICS)
    expect(
      buildFilePicker(SPEC, STYLE, narrow, METRICS, {
        names: [],
        enabled: true,
      }).text,
    ).toHaveLength(0)
  })
})
