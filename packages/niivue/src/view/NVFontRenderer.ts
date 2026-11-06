import {
  buildTextLayout,
  calculateFontSizePx,
  emptyBatch,
  type FontMetrics,
  type GlyphBatch,
  measureTextWidth,
} from './NVFont'
import { NVRenderer } from './NVRenderer'

/**
 * Text layout shared by the WebGL2 and WebGPU font renderers: the atlas
 * metrics, the rasterized size and the CPU side of `buildText`.
 */
export abstract class NVFontRenderer extends NVRenderer {
  protected fontMets: FontMetrics | null = null
  private _fontPx = 16

  /** Current rasterized font size in device pixels (post-resize). */
  get fontPx(): number {
    return this._fontPx
  }

  protected resizeFont(
    width: number,
    height: number,
    dpi: number,
    fontSizeScaling: number,
    fontMinPx: number,
  ): void {
    this._fontPx = calculateFontSizePx(
      width,
      height,
      dpi,
      fontSizeScaling,
      fontMinPx,
    )
  }

  /** Width of `str` in px at `scale`, as buildText draws it; 0 before init. */
  measureText(str: string, scale: number): number {
    if (!this.fontMets) return 0
    return measureTextWidth(str, this._fontPx, scale, this.fontMets)
  }

  buildText(
    str: string,
    x: number,
    y: number,
    scale: number,
    color: number[] = [1, 1, 1, 1],
    anchorX: number = 0,
    anchorY: number = 0,
    backColor: number[] = [0, 0, 0, 0],
  ): GlyphBatch {
    if (!this.isReady || !this.fontMets) return emptyBatch()
    return buildTextLayout(
      str,
      x,
      y,
      this._fontPx,
      scale,
      this.fontMets,
      color,
      anchorX,
      anchorY,
      backColor,
    )
  }
}
