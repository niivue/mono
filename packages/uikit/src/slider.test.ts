import { describe, expect, it } from 'bun:test'
import {
  buildSlider,
  DEFAULT_SLIDER_STYLE,
  effectiveStep,
  formatSliderValue,
  layoutSlider,
  resolveSliderStyle,
  type SliderSpec,
  type SliderVisual,
  scaleSlider,
  sliderContains,
  sliderThumbX,
  sliderValueAt,
  snapValue,
  stepValue,
  valueToFraction,
} from './slider'
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
const STYLE = DEFAULT_SLIDER_STYLE
const SPEC: SliderSpec = {
  id: 's',
  label: 'Hi',
  x: 100,
  y: 50,
  width: 200,
  min: 0,
  max: 10,
  step: 1,
  value: 2,
}
const IDLE: SliderVisual = {
  value: 2,
  hover: false,
  active: false,
  focused: false,
  enabled: true,
}

function expectColor(got: ArrayLike<number>, want: readonly number[]): void {
  expect(got.length).toBe(4)
  for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 5)
}

describe('snapValue', () => {
  it('clamps into the range', () => {
    expect(snapValue(12, 0, 10)).toBe(10)
    expect(snapValue(-1, 0, 10)).toBe(0)
    expect(snapValue(Number.NaN, 0, 10)).toBe(0)
  })

  it('snaps to the step grid from min without float noise', () => {
    expect(snapValue(0.35, 0, 1, 0.1)).toBe(0.4)
    expect(snapValue(0.3 + 0.1 + 0.1, 0, 1, 0.1)).toBe(0.5)
    expect(snapValue(2.3, 0, 10, 1)).toBe(2)
    expect(snapValue(0.7, 0.5, 1, 0.3)).toBe(0.8)
    expect(snapValue(1, 0.5, 1, 0.3)).toBe(1)
    expect(snapValue(3, 0, 10, 1e-7)).toBe(3)
  })

  it('leaves a continuous value alone inside the range', () => {
    expect(snapValue(0.123456, 0, 1)).toBe(0.123456)
  })
})

describe('value and fraction', () => {
  it('maps the range to 0..1 and copes with an empty range', () => {
    expect(valueToFraction(5, 0, 10)).toBe(0.5)
    expect(valueToFraction(20, 0, 10)).toBe(1)
    expect(valueToFraction(3, 3, 3)).toBe(0)
  })

  it('steps by the spec step or a hundredth of the range', () => {
    expect(effectiveStep({ min: 0, max: 10, step: 0.5 })).toBe(0.5)
    expect(effectiveStep({ min: 0, max: 10 })).toBe(0.1)
    expect(stepValue(2, SPEC, 1)).toBe(3)
    expect(stepValue(2, SPEC, -1, true)).toBe(0)
    expect(stepValue(9, SPEC, 1, true)).toBe(10)
    expect(stepValue(0.5, { min: 0, max: 1 }, 1)).toBe(0.51)
    expect(stepValue(0.5, { min: 0, max: 1 }, -1, true)).toBe(0.4)
  })

  it('formats to the step precision, two tidy decimals, or the custom formatter', () => {
    expect(formatSliderValue({ step: 0.05 }, 0.5)).toBe('0.50')
    expect(formatSliderValue({ step: 1 }, 7)).toBe('7')
    expect(formatSliderValue({}, 0.5)).toBe('0.5')
    expect(formatSliderValue({}, 1 / 3)).toBe('0.33')
    expect(formatSliderValue({ format: (v) => `${v * 100}%` }, 0.5)).toBe('50%')
  })
})

describe('layoutSlider', () => {
  it('puts a label row above the thumb row and insets the rail by half a thumb', () => {
    const l = layoutSlider(SPEC, STYLE, METRICS)
    // Label row: 9.8 cap height + 6 gap; thumb row 18.
    expect(l).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 34,
      track: { x: 100, y: 71.8, width: 200, height: 6 },
      rail: { x0: 109, x1: 291, cy: 74.8 },
      labelBaseline: 59.8,
    })
  })

  it('drops the label row without a label or value, and adds tick room', () => {
    const bare = layoutSlider({ ...SPEC, label: undefined }, STYLE, METRICS)
    expect(bare.height).toBe(18)
    expect(bare.labelBaseline).toBeNull()
    expect(bare.rail.cy).toBe(59)
    const valued = layoutSlider(
      { ...SPEC, label: undefined, showValue: true },
      STYLE,
      METRICS,
    )
    expect(valued.labelBaseline).toBe(59.8)
    const ticked = layoutSlider(
      { ...SPEC, label: undefined, tickStep: 5 },
      STYLE,
      METRICS,
    )
    expect(ticked.height).toBe(24)
  })

  it('never lets the rail invert on a control narrower than the thumb', () => {
    const l = layoutSlider({ ...SPEC, width: 10 }, STYLE, METRICS)
    expect(l.rail.x1).toBe(l.rail.x0)
    expect(sliderValueAt(l, SPEC, 105)).toBe(0)
  })
})

describe('rail mapping', () => {
  const l = layoutSlider(SPEC, STYLE, METRICS)

  it('places the thumb by value', () => {
    expect(sliderThumbX(l, SPEC, 0)).toBe(109)
    expect(sliderThumbX(l, SPEC, 10)).toBe(291)
    expect(sliderThumbX(l, SPEC, 5)).toBe(200)
  })

  it('reads a snapped value from a pointer x, clamped at the ends', () => {
    expect(sliderValueAt(l, SPEC, 200)).toBe(5)
    expect(sliderValueAt(l, SPEC, 205)).toBe(5)
    expect(sliderValueAt(l, SPEC, 50)).toBe(0)
    expect(sliderValueAt(l, SPEC, 400)).toBe(10)
    expect(sliderValueAt(l, { min: 0, max: 1 }, 200)).toBe(0.5)
  })

  it('hit-tests the whole control box', () => {
    expect(sliderContains(l, 100, 50)).toBe(true)
    expect(sliderContains(l, 299, 83)).toBe(true)
    expect(sliderContains(l, 300, 60)).toBe(false)
    expect(sliderContains(l, 200, 84)).toBe(false)
  })
})

describe('scaleSlider', () => {
  it('scales positions, width and lengths, leaving colors alone', () => {
    const { spec, style } = scaleSlider(SPEC, STYLE, 2)
    expect(spec.x).toBe(200)
    expect(spec.width).toBe(400)
    expect(spec.min).toBe(0)
    expect(style.thumbSize).toBe(36)
    expect(style.trackHeight).toBe(12)
    expect(style.textSizePx).toBe(28)
    expect(style.thumbFill).toBe(STYLE.thumbFill)
    expect(scaleSlider(SPEC, STYLE, 1).spec).toBe(SPEC)
  })
})

describe('buildSlider', () => {
  const layout = layoutSlider(SPEC, STYLE, METRICS)

  it('draws track, active fill up to the thumb, the thumb, and the label', () => {
    const geo = buildSlider(SPEC, STYLE, layout, IDLE)
    expect(geo.rects.length).toBe(3)
    const [track, active, thumb] = geo.rects
    expect(track.data[2]).toBe(200)
    expectColor(track.data.slice(8, 12), STYLE.trackFill)
    expect(active.data[2]).toBeCloseTo(sliderThumbX(layout, SPEC, 2) - 100)
    expectColor(active.data.slice(8, 12), STYLE.trackActiveFill)
    expect(thumb.data[0] + 9).toBeCloseTo(sliderThumbX(layout, SPEC, 2))
    expect(thumb.data[1] + 9).toBeCloseTo(74.8)
    expectColor(thumb.data.slice(8, 12), STYLE.thumbFill)
    expect(geo.lines.length).toBe(0)
    expect(geo.text.length).toBe(1)
    expect(geo.text[0]).toMatchObject({ str: 'Hi', x: 100, y: 59.8, align: 0 })
  })

  it('shows the formatted value right-aligned when asked', () => {
    const spec = { ...SPEC, showValue: true, step: 0.5 }
    const geo = buildSlider(spec, STYLE, layout, {
      ...IDLE,
      value: 2.5,
    })
    expect(geo.text.length).toBe(2)
    expect(geo.text[1]).toMatchObject({ str: '2.5', x: 300, align: 1 })
  })

  it('draws a tick per tickStep across the range', () => {
    const spec = { ...SPEC, tickStep: 5 }
    const l = layoutSlider(spec, STYLE, METRICS)
    const geo = buildSlider(spec, STYLE, l, IDLE)
    expect(geo.lines.length).toBe(3)
    expect(geo.lines[0].data[0]).toBe(109)
    expect(geo.lines[2].data[0]).toBe(291)
  })

  it('tints the thumb for hover and drag, and rings it when focused', () => {
    const hover = buildSlider(SPEC, STYLE, layout, {
      ...IDLE,
      hover: true,
    })
    expectColor(hover.rects[2].data.slice(8, 12), STYLE.thumbHoverFill)
    const active = buildSlider(SPEC, STYLE, layout, {
      ...IDLE,
      hover: true,
      active: true,
    })
    expectColor(active.rects[2].data.slice(8, 12), STYLE.thumbActiveFill)
    const focused = buildSlider(SPEC, STYLE, layout, {
      ...IDLE,
      focused: true,
    })
    expect(focused.rects.length).toBe(4)
    expectColor(focused.rects[2].data.slice(12, 16), STYLE.focusRing)
  })

  it('dims a disabled slider and drops hover, drag and focus styling', () => {
    const geo = buildSlider(SPEC, STYLE, layout, {
      ...IDLE,
      hover: true,
      active: true,
      focused: true,
      enabled: false,
    })
    expect(geo.rects.length).toBe(3)
    const thumb = geo.rects[2].data.slice(8, 12)
    expect(thumb[3]).toBeCloseTo(STYLE.thumbFill[3] * 0.5)
    expectColor(geo.text[0].color ?? [], STYLE.disabledTextColor)
  })

  it('draws no active fill when the thumb sits at the track start', () => {
    const spec = { ...SPEC, style: undefined }
    const style = resolveSliderStyle(STYLE, { thumbSize: 0 })
    const l = layoutSlider(spec, style, METRICS)
    const geo = buildSlider(spec, style, l, { ...IDLE, value: 0 })
    expect(geo.rects.length).toBe(2)
  })
})
