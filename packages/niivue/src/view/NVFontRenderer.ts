import { FLOATS_PER_GLYPH } from '@niivue/uikit'
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
  private _glyphScratch = new Float32Array(0)

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

  /** Every label's glyph records in one reused buffer, and their count. */
  protected packGlyphs(textList: GlyphBatch[]): {
    glyphs: Float32Array
    count: number
  } {
    let count = 0
    for (const item of textList) count += item.count
    if (this._glyphScratch.length < count * FLOATS_PER_GLYPH)
      this._glyphScratch = new Float32Array(count * FLOATS_PER_GLYPH)
    let at = 0
    for (const item of textList) {
      this._glyphScratch.set(item.data, at)
      at += item.count * FLOATS_PER_GLYPH
    }
    return { glyphs: this._glyphScratch, count }
  }
}
