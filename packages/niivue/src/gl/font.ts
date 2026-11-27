import { GlTextRenderer } from '@niivue/uikit'
import { log } from '@/logger'
import { applyCORS } from '@/NVLoader'
import type { NVFontData } from '@/NVTypes'
import { FLOATS_PER_PANEL, type GlyphBatch, packPanels } from '@/view/NVFont'
import { NVFontRenderer } from '@/view/NVFontRenderer'
import { blendOver } from './glUtil'
import { panelFragShader, panelVertShader } from './panelShader'
import { Shader } from './shader'

const BYTES_PER_PANEL = FLOATS_PER_PANEL * 4

function loadFontImage(pngPath: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    applyCORS(img)
    img.src = pngPath
  })
}

export class FontRenderer extends NVFontRenderer {
  private _gl: WebGL2RenderingContext | null = null
  // Glyphs draw through uikit's text renderer; the panels stay here.
  private readonly _glyphs = new GlTextRenderer()
  private _atlas: HTMLImageElement | null = null
  private _scratch = new Float32Array(0)
  private _canvasWidth = 1
  private _canvasHeight = 1
  private _panelShader: Shader | null = null
  private _panelVao: WebGLVertexArrayObject | null = null
  private _panelBuffer: WebGLBuffer | null = null
  // Bumped by every init and destroy, so an atlas that loads after either
  // frees itself instead of allocating for a disposed renderer.
  private _initToken = 0

  async init(gl: WebGL2RenderingContext, fontData?: NVFontData): Promise<void> {
    if (this.isReady) return
    if (!fontData) return
    this._gl = gl
    const token = ++this._initToken
    try {
      const atlas = await loadFontImage(fontData.atlasUrl)
      if (token !== this._initToken) return
      this._atlas = atlas
      this.fontMets = fontData.metrics
      // Panel shader for label backing rects
      this._panelShader = new Shader(gl, panelVertShader, panelFragShader)
      this._panelVao = gl.createVertexArray()
      if (!this._panelVao) {
        throw new Error('Failed to create panel VAO')
      }
      gl.bindVertexArray(this._panelVao)
      this._panelBuffer = gl.createBuffer()
      if (!this._panelBuffer) {
        gl.bindVertexArray(null)
        throw new Error('Failed to create panel buffer')
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._panelBuffer)
      const pRect = gl.getAttribLocation(this._panelShader.program, 'panelRect')
      const pColor = gl.getAttribLocation(
        this._panelShader.program,
        'panelColor',
      )
      const pShape = gl.getAttribLocation(
        this._panelShader.program,
        'panelShape',
      )
      gl.enableVertexAttribArray(pRect)
      gl.vertexAttribPointer(pRect, 4, gl.FLOAT, false, BYTES_PER_PANEL, 0)
      gl.vertexAttribDivisor(pRect, 1)
      gl.enableVertexAttribArray(pColor)
      gl.vertexAttribPointer(pColor, 4, gl.FLOAT, false, BYTES_PER_PANEL, 16)
      gl.vertexAttribDivisor(pColor, 1)
      gl.enableVertexAttribArray(pShape)
      gl.vertexAttribPointer(pShape, 2, gl.FLOAT, false, BYTES_PER_PANEL, 32)
      gl.vertexAttribDivisor(pShape, 1)
      gl.bindVertexArray(null)
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

  createBindGroup() {
    return null
  }

  draw(
    gl: WebGL2RenderingContext,
    _pass: unknown,
    _bindGroup: unknown,
    _storageBuffer: unknown,
    textList: GlyphBatch[],
  ): void {
    if (!this.isReady || textList.length === 0) return
    // Panel pass: draw backing rectangles first
    if (this._panelShader && this._panelVao && this._panelBuffer) {
      const panelData = packPanels(textList)
      if (panelData) {
        const panelCount = panelData.length / FLOATS_PER_PANEL
        gl.bindBuffer(gl.ARRAY_BUFFER, this._panelBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, panelData, gl.DYNAMIC_DRAW)
        this._panelShader.use(gl)
        if (this._panelShader.uniforms.canvasSize)
          gl.uniform2f(
            this._panelShader.uniforms.canvasSize,
            this._canvasWidth,
            this._canvasHeight,
          )
        gl.depthMask(false)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.CULL_FACE)
        gl.enable(gl.BLEND)
        blendOver(gl)
        gl.bindVertexArray(this._panelVao)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, panelCount)
        gl.bindVertexArray(null)
        gl.depthMask(true)
        gl.enable(gl.DEPTH_TEST)
        gl.enable(gl.CULL_FACE)
      }
    }
    // Glyph pass: every label's records in one instanced draw.
    let total = 0
    for (const item of textList) total += item.count
    if (total === 0 || !this._atlas) return
    if (this._scratch.length < total * 16)
      this._scratch = new Float32Array(total * 16)
    let at = 0
    for (const item of textList) {
      this._scratch.set(item.data, at)
      at += item.count * 16
    }
    this._glyphs.draw(
      gl,
      this._atlas,
      this._scratch,
      total,
      this._canvasWidth,
      this._canvasHeight,
    )
  }

  destroy(): void {
    this._initToken++
    const gl = this._gl
    if (!gl) return
    this._glyphs.destroy()
    if (this._panelVao) gl.deleteVertexArray(this._panelVao)
    if (this._panelBuffer) gl.deleteBuffer(this._panelBuffer)
    if (this._panelShader?.program) gl.deleteProgram(this._panelShader.program)
    this.isReady = false
    this._atlas = null
    this.fontMets = null
    this._panelShader = null
    this._panelVao = null
    this._panelBuffer = null
    this._gl = null
  }
}
