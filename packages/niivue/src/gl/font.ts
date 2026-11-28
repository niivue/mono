import { GlRectRenderer, GlTextRenderer } from '@niivue/uikit'
import { log } from '@/logger'
import { applyCORS } from '@/NVLoader'
import type { NVFontData } from '@/NVTypes'
import { type GlyphBatch, panelRects } from '@/view/NVFont'
import { NVFontRenderer } from '@/view/NVFontRenderer'

function loadFontImage(pngPath: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    applyCORS(img)
    img.src = pngPath
  })
}

/** Core's labels on WebGL2: panels and glyphs through uikit's renderers. */
export class FontRenderer extends NVFontRenderer {
  private readonly _panels = new GlRectRenderer()
  private readonly _glyphs = new GlTextRenderer()
  private _atlas: HTMLImageElement | null = null
  private _canvasWidth = 1
  private _canvasHeight = 1
  // Bumped by every init and destroy, so an atlas that loads after either is
  // dropped instead of reviving a disposed renderer.
  private _initToken = 0

  async init(
    _gl: WebGL2RenderingContext,
    fontData?: NVFontData,
  ): Promise<void> {
    if (this.isReady) return
    if (!fontData) return
    const token = ++this._initToken
    try {
      const atlas = await loadFontImage(fontData.atlasUrl)
      if (token !== this._initToken) return
      this._atlas = atlas
      this.fontMets = fontData.metrics
      this.isReady = true
    } catch (err) {
      log.error('Failed to initialize font system:', err)
      this.isReady = false
    }
  }

  resize(
    _gl: WebGL2RenderingContext,
    width: number,
    height: number,
    dpi: number = 1,
    fontSizeScaling: number = 0.4,
    fontMinPx: number = 13,
  ): void {
    this._canvasWidth = width
    this._canvasHeight = height
    this.resizeFont(width, height, dpi, fontSizeScaling, fontMinPx)
  }

  draw(gl: WebGL2RenderingContext, textList: GlyphBatch[]): void {
    if (!this.isReady || !this._atlas || textList.length === 0) return
    const w = this._canvasWidth
    const h = this._canvasHeight
    // Backing panels first, then every label's glyphs in one instanced draw.
    this._panels.draw(gl, panelRects(textList), w, h)
    const { glyphs, count } = this.packGlyphs(textList)
    this._glyphs.draw(gl, this._atlas, glyphs, count, w, h)
  }

  destroy(): void {
    this._initToken++
    this._panels.destroy()
    this._glyphs.destroy()
    this.isReady = false
    this._atlas = null
    this.fontMets = null
  }
}
