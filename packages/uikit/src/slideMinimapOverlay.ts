// A whole-slide minimap for an NVSlide: a thumbnail built from the slide's
// coarsest pyramid level in a canvas corner, with a box marking what the
// viewport shows. Pressing or dragging on it recenters the viewport there.
//
// NVSlide.thumbnailBitmap composites the coarsest level on the CPU (scalar
// tiles through their channels, scaled to MAX_THUMBNAIL_PX), copied here into
// one canvas when it changes,
// so the GPU side is a single textured quad and nothing leaks when NVSlide's
// cache evicts a tile.

import type { NVSlide, UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitInteractive } from './controls'
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
  'manifest' | 'viewport' | 'isYAxisUp' | 'setViewport' | 'thumbnailBitmap'
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

// shortcut: the thumbnail is the coarsest level capped at this side, sampled
// bilinearly without mipmaps; raise it or add mips if a large minimap aliases.
const MAX_THUMBNAIL_PX = 1024

export class UIKitSlideMinimapOverlay implements UIKitInteractive {
  readonly hoverCursor = 'pointer'
  private readonly slide: UIKitMinimapSlide
  private readonly options: Required<UIKitSlideMinimapOptions>
  private readonly panelRects = new UIKitRectOverlay()
  private readonly viewRects = new UIKitRectOverlay()
  private readonly gl = new GlImageRenderer()
  private readonly wgpu = new WgpuImageRenderer()
  private thumbnail: OffscreenCanvas | null = null
  private thumbnailVersion = 0
  // NVSlide returns the same bitmap until a tile or the channels change.
  private drawnBitmap: ImageBitmap | null = null
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

  /** Redraw the thumbnail when the slide's coarsest-level composite changed. */
  private updateThumbnail(): void {
    const bitmap = this.slide.thumbnailBitmap(undefined, MAX_THUMBNAIL_PX)
    // Kept while null (tiles evicted or not yet loaded): the old one stays drawn.
    if (!bitmap || bitmap === this.drawnBitmap) return
    this.thumbnail ??= new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = this.thumbnail.getContext('2d')
    if (!ctx) return
    const { width, height } = this.thumbnail
    ctx.clearRect(0, 0, width, height)
    if (this.slide.isYAxisUp()) {
      // y-up rows are stored bottom-up.
      ctx.save()
      ctx.translate(0, height)
      ctx.scale(1, -1)
      ctx.drawImage(bitmap, 0, 0, width, height)
      ctx.restore()
    } else ctx.drawImage(bitmap, 0, 0, width, height)
    this.drawnBitmap = bitmap
    this.thumbnailVersion++
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const { handle, bounds, dpr } = frame
    const { panel, image, view } = this.layoutFor(
      bounds.width,
      bounds.height,
      dpr,
    )
    this.updateThumbnail()
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
    if (thumb && this.thumbnailVersion > 0) {
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
    this.thumbnail = null
    this.drawnBitmap = null
  }
}
