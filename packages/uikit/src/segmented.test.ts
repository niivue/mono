import { describe, expect, it } from 'bun:test'
import {
  buildSegmented,
  DEFAULT_SEGMENTED_STYLE,
  endSegmentValue,
  layoutSegmented,
  resolveSegmentedStyle,
  type SegmentedSpec,
  type SegmentedVisual,
  scaleSegmented,
  segmentAt,
  segmentedContains,
  segmentIndex,
  stepSegmentValue,
} from './segmented'
import type { UIKitFontMetrics } from './text/font'

// Stub font: 'H' and 'i' advance half an em; cap height is 0.7 em.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const STYLE = DEFAULT_SEGMENTED_STYLE
const SPEC: SegmentedSpec = {
  id: 'g',
  x: 100,
  y: 50,
  segments: [
    { value: 'a', label: 'Hi' },
    { value: 'b', label: 'HiHi' },
    { value: 'c', label: 'Hi', enabled: false },
  ],
  value: 'b',
}
const IDLE: SegmentedVisual = {
  selected: 1,
  hover: -1,
  pressed: -1,
  focused: false,
  enabled: true,
}

function expectColor(got: ArrayLike<number>, want: readonly number[]): void {
  expect(got.length).toBe(4)
  for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 5)
}
// Packed rect data: [x, y, w, h, radius, border, ..., fill rgba (8..12), border rgba (12..16)].
const box = (r: { data: Float32Array }) => Array.from(r.data.slice(0, 4))
const fill = (r: { data: Float32Array }) => r.data.slice(8, 12)
const border = (r: { data: Float32Array }) => r.data.slice(12, 16)
const color = (t: { color?: ArrayLike<number> }) => t.color ?? []

describe('segmented model', () => {
  it('lays out equal segments sized to the widest label inside the inset', () => {
    // 'HiHi' is 28px at 14px: segment 28 + 2*12 = 52; three of them plus 2*2 inset.
    const l = layoutSegmented(SPEC, STYLE, METRICS)
    expect(l).toMatchObject({ x: 100, y: 50, width: 160, height: 28 })
    expect(l.segments).toEqual([
      { index: 0, x: 102, y: 52, width: 52, height: 24 },
      { index: 1, x: 154, y: 52, width: 52, height: 24 },
      { index: 2, x: 206, y: 52, width: 52, height: 24 },
    ])
    const fixed = layoutSegmented(
      { ...SPEC, segmentWidth: 40, height: 20 },
      STYLE,
      METRICS,
    )
    expect(fixed).toMatchObject({ width: 124, height: 20 })
    expect(fixed.segments[2]).toEqual({
      index: 2,
      x: 182,
      y: 52,
      width: 40,
      height: 16,
    })
    expect(resolveSegmentedStyle(STYLE, { inset: 0 }).inset).toBe(0)
    expect(resolveSegmentedStyle(STYLE)).toBe(STYLE)
  })

  it('hit-tests the track and maps points to segments, inset included', () => {
    const l = layoutSegmented(SPEC, STYLE, METRICS)
    expect(segmentedContains(l, 100, 50)).toBe(true)
    expect(segmentedContains(l, 260, 60)).toBe(false)
    expect(segmentedContains(l, 150, 78)).toBe(false)
    expect(segmentAt(l, 101, 51)).toBe(0) // the inset counts toward the nearest segment
    expect(segmentAt(l, 153, 60)).toBe(0)
    expect(segmentAt(l, 154, 60)).toBe(1)
    expect(segmentAt(l, 259, 77)).toBe(2)
    expect(segmentAt(l, 99, 60)).toBe(-1)
    expect(segmentAt({ ...l, segments: [] }, 110, 60)).toBe(-1)
  })

  it('scales positions and lengths together', () => {
    const { spec, style } = scaleSegmented(
      { ...SPEC, segmentWidth: 40 },
      STYLE,
      2,
    )
    expect(spec).toMatchObject({ x: 200, y: 100, segmentWidth: 80 })
    expect(spec.height).toBeUndefined()
    expect(style).toMatchObject({
      height: 56,
      paddingX: 24,
      inset: 4,
      radius: 12,
      textSizePx: 28,
    })
    expect(scaleSegmented(SPEC, STYLE, 1).spec).toBe(SPEC)
  })

  it('steps the value through enabled segments, wrapping like a radio group', () => {
    const segs = SPEC.segments
    expect(segmentIndex(segs, 'c')).toBe(2)
    expect(segmentIndex(segs, null)).toBe(-1)
    expect(stepSegmentValue(segs, 'a', 1)).toBe('b')
    expect(stepSegmentValue(segs, 'b', 1)).toBe('a') // skips disabled 'c' and wraps
    expect(stepSegmentValue(segs, 'a', -1)).toBe('b')
    expect(stepSegmentValue(segs, null, 1)).toBe('a')
    expect(stepSegmentValue(segs, null, -1)).toBe('b')
    expect(stepSegmentValue([], null, 1)).toBeNull()
    const dead = segs.map((s) => ({ ...s, enabled: false }))
    expect(stepSegmentValue(dead, 'a', 1)).toBe('a')
    expect(endSegmentValue(segs, 'b', 'first')).toBe('a')
    expect(endSegmentValue(segs, 'a', 'last')).toBe('b')
    expect(endSegmentValue(dead, 'a', 'last')).toBe('a')
  })

  it('draws the track, a face for the selected segment, dividers and centred labels', () => {
    const l = layoutSegmented(SPEC, STYLE, METRICS)
    const geo = buildSegmented(SPEC, STYLE, METRICS, l, IDLE)
    // Track plus one face.
    expect(geo.rects).toHaveLength(2)
    expect(box(geo.rects[0])).toEqual([100, 50, 160, 28])
    expectColor(fill(geo.rects[0]), STYLE.trackFill)
    expect(box(geo.rects[1])).toEqual([154, 52, 52, 24])
    expectColor(fill(geo.rects[1]), STYLE.selectedFill)
    // Dividers only between two plain segments: 0|1 and 1|2 both touch the
    // selected face, so none here.
    expect(geo.lines).toHaveLength(0)
    expect(geo.text.map((t) => t.str)).toEqual(['Hi', 'HiHi', 'Hi'])
    expect(geo.text[0]).toMatchObject({ x: 128, align: 0.5, sizePx: 14 })
    expect(geo.text[0].y).toBeCloseTo(64 + 4.9, 5)
    expectColor(color(geo.text[0]), STYLE.textColor)
    expectColor(color(geo.text[1]), STYLE.selectedTextColor)
    expectColor(color(geo.text[2]), STYLE.disabledTextColor)
    // No selection: one divider between each pair of plain segments.
    const none = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      selected: -1,
    })
    expect(none.rects).toHaveLength(1)
    expect(none.lines).toHaveLength(2)
    const d = none.lines[0].data
    expect(d[0]).toBe(154)
    expect(d[1]).toBeCloseTo(52 + 4.8, 4)
    expect(d[2]).toBe(154)
    expect(d[3]).toBeCloseTo(76 - 4.8, 4)
  })

  it('tints hovered and pressed segments, rings the focus and dims when disabled', () => {
    const l = layoutSegmented(SPEC, STYLE, METRICS)
    const hover = buildSegmented(SPEC, STYLE, METRICS, l, { ...IDLE, hover: 0 })
    expect(hover.rects).toHaveLength(3)
    expectColor(fill(hover.rects[1]), STYLE.hoverFill) // faces follow segment order
    expectColor(fill(hover.rects[2]), STYLE.selectedFill)
    const pressed = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      hover: 0,
      pressed: 0,
    })
    expectColor(fill(pressed.rects[1]), STYLE.pressedFill)
    // The selected segment keeps its face under the pointer; a disabled one gets none.
    const onSelected = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      hover: 1,
      pressed: 1,
    })
    expect(onSelected.rects).toHaveLength(2)
    expectColor(fill(onSelected.rects[1]), STYLE.selectedFill)
    const onDead = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      hover: 2,
      pressed: 2,
    })
    expect(onDead.rects).toHaveLength(2)
    const focused = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      focused: true,
    })
    expect(focused.rects).toHaveLength(3)
    expect(box(focused.rects[0])).toEqual([97, 47, 166, 34])
    expectColor(border(focused.rects[0]), STYLE.focusRing)
    const disabled = buildSegmented(SPEC, STYLE, METRICS, l, {
      ...IDLE,
      focused: true,
      hover: 0,
      enabled: false,
    })
    expect(disabled.rects).toHaveLength(2) // no ring, no hover face
    expect(fill(disabled.rects[0])[3]).toBeLessThan(STYLE.trackFill[3])
    expect(
      disabled.text.every((t) => color(t)[3] === STYLE.disabledTextColor[3]),
    ).toBe(true)
  })
})
