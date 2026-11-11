// A whole-slide minimap for an NVSlide: a thumbnail built from the slide's
// coarsest pyramid level in a canvas corner, with a box marking what the
// viewport shows. Pressing or dragging on it recenters the viewport there.
//
// The coarsest tiles are composited on the CPU into one canvas as they arrive
// (they are already channel-composited bitmaps), so the GPU side is a single
// textured quad and nothing leaks when NVSlide's cache evicts a tile.

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
  | 'manifest'
  | 'viewport'
  | 'isYAxisUp'
  | 'setViewport'
  | 'requestTile'
  | 'cachedTileBitmap'
  | 'tileKey'
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
  private readonly drawnTiles = new Set<string>()
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

  /** Composite any newly cached coarsest-level tiles into the thumbnail. */
  private updateThumbnail(): void {
    const { manifest } = this.slide
    const level = manifest.levels.at(-1)
    if (!level) return
    const tileW = level.tileWidth ?? manifest.tileSize ?? 1
    const tileH = level.tileHeight ?? manifest.tileSize ?? 1
    const k = Math.min(
      1,
      MAX_THUMBNAIL_PX / Math.max(level.width, level.height),
    )
    if (!this.thumbnail) {
      this.thumbnail = new OffscreenCanvas(
        Math.max(1, Math.round(level.width * k)),
        Math.max(1, Math.round(level.height * k)),
      )
    }
    const ctx = this.thumbnail.getContext('2d')
    if (!ctx) return
    const yUp = this.slide.isYAxisUp()
    for (const tile of level.tiles) {
      if (!tile) continue
      const key = this.slide.tileKey(level, tile)
      if (this.drawnTiles.has(key)) continue
      this.slide.requestTile(level, tile)
      const bitmap = this.slide.cachedTileBitmap(key)
      if (!bitmap) continue
      const x = tile.x * tileW * k
      const w = tile.width * k
      const h = tile.height * k
      const y = tile.y * tileH * k
      if (yUp) {
        // y-up tiles stack from the bottom and their rows are stored bottom-up.
        ctx.save()
        ctx.translate(x, this.thumbnail.height - y)
        ctx.scale(1, -1)
        ctx.drawImage(bitmap, 0, 0, w, h)
        ctx.restore()
      } else {
        ctx.drawImage(bitmap, x, y, w, h)
      }
      this.drawnTiles.add(key)
      this.thumbnailVersion++
    }
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
    this.drawnTiles.clear()
  }
}
