import { WgpuRectRenderer, WgpuTextRenderer } from '@niivue/uikit'
import { log } from '@/logger'
import { loadImageElement } from '@/NVLoader'
import type { NVFontData } from '@/NVTypes'
import { type GlyphBatch, panelRects } from '@/view/NVFont'
import { NVFontRenderer } from '@/view/NVFontRenderer'

/** Core's labels on WebGPU: panels and glyphs through uikit's renderers. */
export class FontRenderer extends NVFontRenderer {
  private readonly _panels = new WgpuRectRenderer()
  private readonly _glyphs = new WgpuTextRenderer()
  private _atlas: ImageBitmap | null = null
  // Bumped by every init and destroy, so an atlas that loads after either is
  // dropped instead of reviving a disposed renderer.
  private _initToken = 0
  private _format: GPUTextureFormat = 'bgra8unorm'
  private _msaaCount = 1
  private _depthFormat: GPUTextureFormat | undefined
  private _width = 1
  private _height = 1

  /** `depthFormat` null: for a pass with no depth attachment (the slide pane). */
  async init(
    _device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    fontData?: NVFontData,
    depthFormat: GPUTextureFormat | null = 'depth24plus',
  ): Promise<void> {
    if (this.isReady) return
    if (!fontData) return
    const token = ++this._initToken
    try {
      const atlas = await createImageBitmap(
        await loadImageElement(fontData.atlasUrl),
      )
      if (token !== this._initToken) {
        atlas.close()
        return
      }
      this._atlas = atlas
      this.fontMets = fontData.metrics
      this._format = format
      this._msaaCount = msaaCount
      this._depthFormat = depthFormat ?? undefined
      this.isReady = true
    } catch (err) {
      log.error('Failed to initialize font system:', err)
      this.isReady = false
    }
  }

  resize(
    _device: GPUDevice,
    width: number,
    height: number,
    dpi: number = 1,
    fontSizeScaling: number = 0.4,
    fontMinPx: number = 13,
  ): void {
    if (!this.isReady) return
    this._width = width
    this._height = height
    this.resizeFont(width, height, dpi, fontSizeScaling, fontMinPx)
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    textList: GlyphBatch[],
  ): void {
    if (!this.isReady || !this._atlas || textList.length === 0) return
    const f = this._format
    const n = this._msaaCount
    const d = this._depthFormat
    const w = this._width
    const h = this._height
    // Backing panels first, then every label's glyphs in one instanced draw.
    this._panels.draw(device, pass, f, n, d, panelRects(textList), w, h)
    const { glyphs, count } = this.packGlyphs(textList)
    this._glyphs.draw(device, pass, f, n, d, this._atlas, glyphs, count, w, h)
  }

  destroy(): void {
    this._initToken++
    this._panels.destroy()
    this._glyphs.destroy()
    this._atlas?.close()
    this._atlas = null
    this.fontMets = null
    this.isReady = false
  }
}
