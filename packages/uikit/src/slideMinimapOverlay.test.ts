import { describe, expect, it } from 'bun:test'
import type { NVSlideManifest, NVSlideViewport } from '@niivue/niivue'
import {
  type UIKitMinimapSlide,
  UIKitSlideMinimapOverlay,
} from './slideMinimapOverlay'

// Pointer handling never touches the GPU or the thumbnail, so a fake slide
// with just the viewport is enough.
function fakeSlide(yAxisUp = false) {
  const manifest = {
    width: 1000,
    height: 500,
    levels: [],
    displayYAxis: yAxisUp ? 'up' : 'down',
  } as unknown as NVSlideManifest
  const slide = {
    manifest,
    viewport: { centerX: 500, centerY: 250, scale: 1 } as NVSlideViewport,
    isYAxisUp: () => yAxisUp,
    setViewport(v: NVSlideViewport) {
      slide.viewport = { ...v }
    },
    requestTile() {},
    cachedTileBitmap: () => null,
    tileKey: () => '',
  }
  return slide
}

describe('UIKitSlideMinimapOverlay', () => {
  it('recenters on press and drag inside the panel, keeping the scale', () => {
    const slide = fakeSlide()
    const minimap = new UIKitSlideMinimapOverlay(slide as UIKitMinimapSlide, {
      sizeCss: 100,
      marginCss: 10,
      paddingCss: 2,
    })
    const { image } = minimap.layoutFor(800, 600, 2)
    expect(minimap.pointerDown(10, 10)).toBe(false)
    expect(slide.viewport.centerX).toBe(500)

    expect(minimap.pointerDown(image.x + 50, image.y + 25)).toBe(true)
    expect(slide.viewport.centerX).toBeCloseTo(250)
    expect(slide.viewport.centerY).toBeCloseTo(125)
    expect(slide.viewport.scale).toBe(1)
    // A drag keeps steering even past the panel edge, clamped to the slide.
    expect(minimap.pointerMove(0, 0)).toBe(true)
    expect(slide.viewport.centerX).toBe(0)
    expect(slide.viewport.centerY).toBe(0)
    expect(minimap.pointerUp(0, 0)).toBe(true)
    expect(minimap.pointerMove(image.x, image.y)).toBe(false)
  })

  it('maps y-up slides bottom-up', () => {
    const slide = fakeSlide(true)
    const minimap = new UIKitSlideMinimapOverlay(slide as UIKitMinimapSlide, {
      sizeCss: 100,
    })
    const { image } = minimap.layoutFor(800, 600, 2)
    minimap.pointerDown(image.x + 50, image.y + 25)
    expect(slide.viewport.centerY).toBeCloseTo(375)
    minimap.pointerCancel()
    expect(minimap.pointerMove(image.x, image.y)).toBe(false)
  })
})
