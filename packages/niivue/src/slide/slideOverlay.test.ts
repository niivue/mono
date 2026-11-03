import { describe, expect, test } from 'bun:test'
import type { NVSlide } from './NVSlide'
import { slideOverlayContent } from './slideOverlay'

const slide = (pixelSpacingMM?: [number, number]) =>
  ({
    manifest: { pixelSpacingMM },
    slideToScreen: (x: number, y: number) => ({ xCss: x, yCss: y }),
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

  test('without spacing a ruler reads in px and has no ticks', () => {
    const [r] = slideOverlayContent(slide(), screen, source).rulers
    expect(r.distance).toBe(0)
    expect(r.label).toBe('50 px')
  })
})
