import { describe, expect, it } from 'bun:test'
import {
  layoutSlideMinimap,
  minimapToSlide,
  type SlideMinimapSpec,
} from './slideMinimap'

// 1000x500 slide, 800x600 canvas at dpr 2 (400x300 CSS), 1 CSS px per slide px.
const spec = (over: Partial<SlideMinimapSpec> = {}): SlideMinimapSpec => ({
  width: 800,
  height: 600,
  dpr: 2,
  slideWidth: 1000,
  slideHeight: 500,
  viewport: { centerX: 500, centerY: 250, scale: 1 },
  yAxisUp: false,
  corner: 'bottom-right',
  sizeCss: 100,
  marginCss: 10,
  paddingCss: 2,
  ...over,
})

describe('layoutSlideMinimap', () => {
  it('fits the slide into sizeCss and anchors the panel in the corner', () => {
    const { panel, image } = layoutSlideMinimap(spec())
    expect(image.width).toBeCloseTo(200)
    expect(image.height).toBeCloseTo(100)
    expect(panel.x + panel.width).toBeCloseTo(800 - 20)
    expect(panel.y + panel.height).toBeCloseTo(600 - 20)
    expect(image.x - panel.x).toBeCloseTo(4)
    const tl = layoutSlideMinimap(spec({ corner: 'top-left' }))
    expect(tl.panel.x).toBeCloseTo(20)
    expect(tl.panel.y).toBeCloseTo(20)
  })

  it('marks the viewport footprint (y down)', () => {
    // 400x300 CSS at scale 1 shows slide x 300..700, y 100..400 -> fit 0.2.
    const { image, view } = layoutSlideMinimap(spec())
    expect(view?.x).toBeCloseTo(image.x + 60)
    expect(view?.y).toBeCloseTo(image.y + 20)
    expect(view?.width).toBeCloseTo(80)
    expect(view?.height).toBeCloseTo(60)
  })

  it('flips the footprint when y grows up', () => {
    // Slide y 0..100 is the bottom of the thumbnail when y grows up.
    const viewport = { centerX: 500, centerY: 50, scale: 4 } // 100x75 CSS -> y 12.5..87.5
    const down = layoutSlideMinimap(spec({ viewport })).view
    const up = layoutSlideMinimap(spec({ viewport, yAxisUp: true }))
    expect(up.view?.height).toBeCloseTo(down?.height ?? Number.NaN)
    expect(up.view?.y).toBeCloseTo(up.image.y + (500 - 87.5) * 0.2)
  })

  it('clips the footprint to the thumbnail and drops it when off-slide', () => {
    const zoomedOut = layoutSlideMinimap(
      spec({ viewport: { centerX: 500, centerY: 250, scale: 0.1 } }),
    )
    expect(zoomedOut.view).toEqual(zoomedOut.image)
    const away = layoutSlideMinimap(
      spec({ viewport: { centerX: 5000, centerY: 250, scale: 1 } }),
    )
    expect(away.view).toBeNull()
  })
})

describe('minimapToSlide', () => {
  it('inverts the thumbnail mapping in both y modes and clamps', () => {
    for (const yAxisUp of [false, true]) {
      const s = spec({ yAxisUp })
      const layout = layoutSlideMinimap(s)
      const { image } = layout
      const p = minimapToSlide(layout, s, image.x + 50, image.y + 25)
      expect(p.x).toBeCloseTo(250)
      expect(p.y).toBeCloseTo(yAxisUp ? 375 : 125)
      expect(minimapToSlide(layout, s, -1e6, 1e6)).toEqual({
        x: 0,
        y: yAxisUp ? 0 : 500,
      })
    }
  })
})
