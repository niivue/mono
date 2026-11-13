import { describe, expect, test } from 'bun:test'
import type { NVSlide } from './NVSlide'
import { slideOverlayContent, slideScaleBar } from './slideOverlay'

const slide = (pixelSpacingMM?: [number, number]) =>
  ({
    manifest: { pixelSpacingMM },
    slideToScreen: (x: number, y: number) => ({ xCss: x, yCss: y }),
    viewport: { scale: 1 },
  }) as unknown as NVSlide

const source = {
  measurements: [{ start: { x: 0, y: 0 }, end: { x: 30, y: 40 } }],
  activeMeasurement: null,
  selection: null,
}
const screen = { widthCss: 100, heightCss: 100, devicePixelRatio: 2 }

describe('slideOverlayContent', () => {
  test('a ruler measures in mm and sits in device pixels', () => {
    const [r] = slideOverlayContent(slide([0.1, 0.1]), screen, source).rulers
    expect(r).toMatchObject({ sx: 0, sy: 0, ex: 60, ey: 80 })
    expect(r.distance).toBeCloseTo(5)
    expect(r.label).toBeUndefined()
  })

  test('a sub-millimetre ruler reads in micrometres', () => {
    const [r] = slideOverlayContent(
      slide([0.0036, 0.0036]),
      screen,
      source,
    ).rulers
    expect(r.label).toBe('180.0 um')
  })

  test('without spacing a ruler reads in px and has no ticks', () => {
    const [r] = slideOverlayContent(slide(), screen, source).rulers
    expect(r.distance).toBe(0)
    expect(r.label).toBe('50 px')
  })
})

describe('slideScaleBar', () => {
  test('picks a nice length that fits a quarter of the view', () => {
    // 0.5 um/px at 1 device px per base pixel, 1000 px wide: 100 um = 200 px.
    expect(slideScaleBar(0.0005, 1, 1000)).toEqual({
      lengthPx: 200,
      label: '100 um',
    })
  })

  test('switches to mm at 1 mm and tracks zoom', () => {
    expect(slideScaleBar(0.0005, 0.05, 1000)).toEqual({
      lengthPx: 200,
      label: '2 mm',
    })
    expect(slideScaleBar(0.0005, 0.1, 1000)?.label).toBe('1 mm')
    expect(slideScaleBar(0.0005, 0.2, 1000)?.label).toBe('500 um')
  })

  test('a fixed unit labels the bar in it', () => {
    // 0.5 um/px, 1000 px: as auto's 100 um, written 0.1 mm.
    expect(slideScaleBar(0.0005, 1, 1000, 'mm')).toEqual({
      lengthPx: 200,
      label: '0.1 mm',
    })
    expect(slideScaleBar(0.0005, 1, 1000, 'nm')?.label).toBe('100000 nm')
  })

  test('nothing without spacing; metres and kilometres for wide fields', () => {
    expect(slideScaleBar(undefined, 1, 1000)).toBeNull()
    // Sentinel-2: 10 m/px, a 5120 px scene fit to 1280 px.
    expect(slideScaleBar(10000, 0.25, 1280)).toEqual({
      lengthPx: 250,
      label: '10 km',
    })
    expect(slideScaleBar(10, 1, 1000)?.label).toBe('2 m')
  })
})

describe('slideOverlayContent scale bar', () => {
  test('isRulerVisible places it bottom-left in device pixels', () => {
    const { scaleBar } = slideOverlayContent(
      slide([0.01, 0.01]),
      screen,
      source,
      {
        isRulerVisible: true,
      },
    )
    // 0.005 mm per device px, 200 px wide: 0.26 mm fits, so 200 um = 40 px.
    expect(scaleBar).toEqual({
      x: 24,
      y: 176,
      lengthPx: 40,
      thickness: 8,
      label: '200 um',
    })
  })

  test('rulerUnits reaches the scale bar', () => {
    const { scaleBar } = slideOverlayContent(
      slide([0.01, 0.01]),
      screen,
      source,
      { isRulerVisible: true, rulerUnits: 'mm' },
    )
    expect(scaleBar?.label).toBe('0.2 mm')
  })

  test('off by default and without spacing', () => {
    expect(
      slideOverlayContent(slide([0.01, 0.01]), screen, source).scaleBar,
    ).toBeNull()
    expect(
      slideOverlayContent(slide(), screen, source, { isRulerVisible: true })
        .scaleBar,
    ).toBeNull()
  })
})
