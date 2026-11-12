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
    thumbnailBitmap: (): unknown => null,
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

  function thumbnailRig() {
    const drawn: unknown[] = []
    const ctx = {
      clearRect() {},
      drawImage: (b: unknown) => drawn.push(b),
    }
    const canvases: number[][] = []
    globalThis.OffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number,
      ) {
        canvases.push([width, height])
      }
      getContext = () => ctx
    } as unknown as typeof OffscreenCanvas
    const slide = Object.assign(fakeSlide(), { displayGeneration: 0 })
    let bitmap: object | null = null
    const maxPx: unknown[] = []
    slide.thumbnailBitmap = (_level?: unknown, px?: unknown) => {
      maxPx.push(px)
      return bitmap
    }
    const minimap = new UIKitSlideMinimapOverlay(slide as UIKitMinimapSlide)
    let redraws = 0
    minimap.bindLayer({ requestRedraw: () => redraws++ })
    const peek = minimap as unknown as {
      updateThumbnail(w: number, h: number): void
      thumbnailVersion: number
      composedAt: number
    }
    return {
      drawn,
      canvases,
      slide,
      maxPx,
      peek,
      redraws: () => redraws,
      set: (b: object | null) => {
        bitmap = b
      },
      update: (w = 320, h = 160) => peek.updateThumbnail(w, h),
    }
  }
  const savedCanvas = globalThis.OffscreenCanvas

  it('redraws only when the slide hands back a new thumbnail, at the drawn size', () => {
    try {
      const r = thumbnailRig()
      r.update()
      r.set({ version: 1 })
      r.update()
      r.update()
      r.set({ version: 2 }) // a tile arrived
      r.update()
      r.set(null) // evicted, channels unchanged: the drawn thumbnail stays
      r.update()
      expect(r.drawn).toEqual([{ version: 1 }, { version: 2 }])
      expect(r.peek.thumbnailVersion).toBe(2)
      // Composed near the drawn size, copied at exactly it: no minification.
      expect(new Set(r.maxPx)).toEqual(new Set([320]))
      expect(r.canvases).toEqual([[320, 160]])
      r.update(2000, 1000)
      expect(r.maxPx.at(-1)).toBe(1024)
    } finally {
      globalThis.OffscreenCanvas = savedCanvas
    }
  })

  it('a channel change within the recompose interval waits for a trailing redraw', async () => {
    try {
      const r = thumbnailRig()
      r.set({ version: 1 })
      r.update()
      r.slide.displayGeneration = 1 // a W/L step
      r.set({ version: 2 })
      r.update()
      r.update()
      expect(r.drawn).toEqual([{ version: 1 }])
      await new Promise((done) => setTimeout(done, 120))
      expect(r.redraws()).toBe(1)
      r.update()
      expect(r.drawn).toEqual([{ version: 1 }, { version: 2 }])
    } finally {
      globalThis.OffscreenCanvas = savedCanvas
    }
  })

  it('without a bound layer a channel change composes at once', () => {
    try {
      const r = thumbnailRig()
      ;(r.peek as unknown as { layer: unknown }).layer = null
      r.set({ version: 1 })
      r.update()
      r.slide.displayGeneration = 1
      r.set({ version: 2 })
      r.update()
      expect(r.drawn).toEqual([{ version: 1 }, { version: 2 }])
    } finally {
      globalThis.OffscreenCanvas = savedCanvas
    }
  })

  it('never shows a stale window after the coarse tiles are evicted', () => {
    try {
      // A single-tile coarsest level: evict it, change a channel, reload it.
      const r = thumbnailRig()
      r.set({ version: 1 })
      r.update()
      const peek = r.peek as unknown as { stale: boolean }
      r.peek.composedAt = Number.NEGATIVE_INFINITY
      r.slide.displayGeneration = 1
      r.set(null)
      r.update()
      expect(peek.stale).toBe(true)
      expect(r.peek.thumbnailVersion).toBe(1)
      r.set({ version: 2 })
      r.update()
      // A new version, never the old one again: the upload is not skipped.
      expect(peek.stale).toBe(false)
      expect(r.peek.thumbnailVersion).toBe(2)
      expect(r.drawn).toEqual([{ version: 1 }, { version: 2 }])
    } finally {
      globalThis.OffscreenCanvas = savedCanvas
    }
  })
})
