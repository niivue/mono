// A whole-slide minimap for an NVSlide: a thumbnail built from the slide's
// coarsest pyramid level in a canvas corner, with a box marking what the
// viewport shows. Pressing or dragging on it recenters the viewport there.
//
// NVSlide.thumbnailBitmap composites the coarsest level on the CPU (scalar
// tiles through their channels) at about the size drawn, copied here into one
// canvas at exactly the drawn size when it changes, so the GPU side is a
// single 1:1 textured quad (the GPU never minifies it; the CPU composite
// scales the tiles at 'high' smoothing quality) and nothing
// leaks when NVSlide's cache evicts a tile.

import type { NVSlide, UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitInteractive, UIKitRedrawSource } from './controls'
import { buildRect, rectContains } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { GlImageRenderer } from './render/glImageRenderer'
import { WgpuImageRenderer } from './render/wgpuImageRenderer'
import {
  layoutSlideMinimap,
  type MinimapCorner,
  minimapToSlide,
  type SlideMinimapLayout,
} from './slideMinimap'

/** What the minimap uses of an NVSlide. */
export type UIKitMinimapSlide = Pick<
  NVSlide,
  | 'manifest'
  | 'viewport'
  | 'isYAxisUp'
  | 'setViewport'
  | 'thumbnailBitmap'
  | 'displayGeneration'
>

export interface UIKitSlideMinimapOptions {
  /** Default 'bottom-right'. */
  corner?: MinimapCorner
  /** Longest side of the thumbnail, CSS px. Default 160. */
  sizeCss?: number
  /** Gap from the canvas edges, CSS px. Default 12. */
  marginCss?: number
  /** Panel border around the thumbnail, CSS px. Default 3. */
  paddingCss?: number
  /** Panel color, RGBA 0..1. Default translucent black. */
  panelColor?: readonly number[]
  /** Viewport box color, RGBA 0..1. Default amber. */
  viewColor?: readonly number[]
  /** Viewport box line width, CSS px. Default 1.5. */
  viewLineCss?: number
}

// The composite never exceeds this side, however large the minimap.
const MAX_THUMBNAIL_PX = 1024
// A window/level drag changes the channels every frame; the CPU composite
// follows at most this often, with a trailing one when the drag stops.
const RECOMPOSE_MS = 100

export class UIKitSlideMinimapOverlay implements UIKitInteractive {
  readonly hoverCursor = 'pointer'
  private readonly slide: UIKitMinimapSlide
  private readonly options: Required<UIKitSlideMinimapOptions>
  private readonly panelRects = new UIKitRectOverlay()
  private readonly viewRects = new UIKitRectOverlay()
  private readonly gl = new GlImageRenderer()
  private readonly wgpu = new WgpuImageRenderer()
  private thumbnail: OffscreenCanvas | null = null
  // Monotonic: the image renderers skip the upload while it is unchanged.
  private thumbnailVersion = 0
  // Hidden while the drawn picture shows channels that have since changed.
  private stale = false
  // NVSlide returns the same bitmap until a tile or the channels change.
  private drawnBitmap: ImageBitmap | null = null
  private drawnGeneration = -1
  private composedAt = Number.NEGATIVE_INFINITY
  private trailing: ReturnType<typeof setTimeout> | undefined
  private layer: UIKitRedrawSource | null = null
  private lastLayout: SlideMinimapLayout | null = null
  private dragging = false

  constructor(
    slide: UIKitMinimapSlide,
    options: UIKitSlideMinimapOptions = {},
  ) {
    this.slide = slide
    this.options = {
      corner: 'bottom-right',
      sizeCss: 160,
      marginCss: 12,
      paddingCss: 3,
      panelColor: [0, 0, 0, 0.55],
      viewColor: [1, 0.8, 0.2, 1],
      viewLineCss: 1.5,
      ...options,
    }
  }

  /** The minimap boxes for a canvas of this size; also kept for hit-testing. */
  layoutFor(width: number, height: number, dpr: number): SlideMinimapLayout {
    const { manifest, viewport } = this.slide
    this.lastLayout = layoutSlideMinimap({
      ...this.options,
      width,
      height,
      dpr,
      slideWidth: manifest.width,
      slideHeight: manifest.height,
      viewport,
      yAxisUp: this.slide.isYAxisUp(),
    })
    return this.lastLayout
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.layer = layer
  }

  /** Redraw the thumbnail when the slide's coarsest-level composite changed. */
  private updateThumbnail(width: number, height: number): void {
    const generation = this.slide.displayGeneration
    if (generation !== this.drawnGeneration) {
      const wait = this.composedAt + RECOMPOSE_MS - performance.now()
      // Unbound (overlayDraw wired by hand): no redraw source, so compose now.
      if (wait > 0 && this.layer) {
        this.trailing ??= setTimeout(() => {
          this.trailing = undefined
          this.layer?.requestRedraw()
        }, wait)
        return
      }
    }
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const bitmap = this.slide.thumbnailBitmap(
      undefined,
      Math.min(MAX_THUMBNAIL_PX, Math.max(w, h)),
    )
    if (!bitmap) {
      // Every coarse tile evicted: the old picture stays only while it still
      // shows the current channels, never a stale window or colour.
      if (generation !== this.drawnGeneration) this.stale = true
      return
    }
    if (
      bitmap === this.drawnBitmap &&
      this.thumbnail?.width === w &&
      this.thumbnail.height === h
    )
      return
    this.composedAt = performance.now()
    if (this.thumbnail?.width !== w || this.thumbnail.height !== h)
      this.thumbnail = new OffscreenCanvas(w, h)
    // CPU-backed: SwiftShader WebGPU's copyExternalImageToTexture of a
    // GPU-backed 2D canvas fails validation ("[Invalid Texture]").
    const ctx = this.thumbnail.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, w, h)
    if (this.slide.isYAxisUp()) {
      // y-up rows are stored bottom-up.
      ctx.save()
      ctx.translate(0, h)
      ctx.scale(1, -1)
      ctx.drawImage(bitmap, 0, 0, w, h)
      ctx.restore()
    } else ctx.drawImage(bitmap, 0, 0, w, h)
    this.drawnBitmap = bitmap
    this.drawnGeneration = generation
    this.thumbnailVersion++
    this.stale = false
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const { handle, bounds, dpr } = frame
    const { panel, image, view } = this.layoutFor(
      bounds.width,
      bounds.height,
      dpr,
    )
    this.updateThumbnail(image.width, image.height)
    this.panelRects.setRects([
      buildRect({ ...panel, radius: 3 * dpr, fill: this.options.panelColor }),
    ])
    this.viewRects.setRects(
      view
        ? [
            buildRect({
              ...view,
              borderWidth: this.options.viewLineCss * dpr,
              fill: [0, 0, 0, 0],
              border: this.options.viewColor,
            }),
          ]
        : [],
    )
    this.panelRects.drawOverlay(frame)
    const thumb = this.thumbnail
    if (thumb && this.thumbnailVersion > 0 && !this.stale) {
      if (handle.backend === 'webgl2') {
        this.gl.draw(
          handle.gl,
          thumb,
          this.thumbnailVersion,
          image,
          bounds.width,
          bounds.height,
        )
      } else {
        this.wgpu.draw(
          handle.device,
          handle.pass,
          handle.colorFormat,
          handle.sampleCount,
          handle.depthFormat,
          thumb,
          this.thumbnailVersion,
          image,
          bounds.width,
          bounds.height,
        )
      }
    }
    this.viewRects.drawOverlay(frame)
  }

  hitTest(x: number, y: number): boolean {
    return !!this.lastLayout && rectContains(this.lastLayout.panel, x, y)
  }

  private recenter(x: number, y: number): void {
    if (!this.lastLayout) return
    const { manifest } = this.slide
    const center = minimapToSlide(
      this.lastLayout,
      {
        slideWidth: manifest.width,
        slideHeight: manifest.height,
        yAxisUp: this.slide.isYAxisUp(),
      },
      x,
      y,
    )
    this.slide.setViewport({
      ...this.slide.viewport,
      centerX: center.x,
      centerY: center.y,
    })
  }

  pointerDown(x: number, y: number): boolean {
    if (!this.hitTest(x, y)) return false
    this.dragging = true
    this.recenter(x, y)
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (!this.dragging) return false
    this.recenter(x, y)
    return true
  }

  pointerUp(_x: number, _y: number): boolean {
    const was = this.dragging
    this.dragging = false
    return was
  }

  pointerCancel(): void {
    this.dragging = false
  }

  destroy(): void {
    this.panelRects.destroy()
    this.viewRects.destroy()
    this.gl.destroy()
    this.wgpu.destroy()
    clearTimeout(this.trailing)
    this.trailing = undefined
    this.thumbnail = null
    this.drawnBitmap = null
  }
}
