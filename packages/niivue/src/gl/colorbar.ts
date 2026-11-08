import * as NVCmaps from '@/cmap/NVCmaps'
import type { ColorbarInfo } from '@/NVTypes'
import { colorbarGridLayout, deriveBorderColor } from '@/view/NVColorbar'
import {
  type ColorbarOptions,
  NVColorbarRenderer,
} from '@/view/NVColorbarRenderer'
import { colorbarFragShader, colorbarVertShader } from './colorbarShader'
import { setTexParams } from './glUtil'
import { Shader } from './shader'

export class ColorbarRenderer extends NVColorbarRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _colorbars: WebGLTexture[] = []
  private _colorbarInfos: ColorbarInfo[] = []

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, colorbarVertShader, colorbarFragShader)
    this.isReady = true
  }

  resize(
    _gl: WebGL2RenderingContext,
    width: number,
    height: number,
    fontPx = 0,
  ): void {
    this._canvasWidth = width
    this._canvasHeight = height
    this._fontPx = fontPx
  }

  /**
   * The part of the canvas the colorbars lay out in ([x, y, width, height]
   * device px, from `layout.inset`); the whole canvas when null.
   */
  setContentRect(rect: number[] | null): void {
    this._content = rect
  }

  setOpacity(_gl: WebGL2RenderingContext, opacity: number): void {
    this._opacity = opacity
  }

  buildColorbars(
    gl: WebGL2RenderingContext,
    colorbars: ColorbarInfo[],
    backColor?: [number, number, number, number],
  ): void {
    if (!this.isReady) return

    if (backColor) {
      this._borderColor = deriveBorderColor(backColor)
    }

    // Destroy old textures
    for (const tex of this._colorbars) {
      gl.deleteTexture(tex)
    }
    this._colorbars = []
    this._colorbarInfos = colorbars

    // Create one texture per colormap
    for (const info of colorbars) {
      const lutData = NVCmaps.lutrgba8(info.colormapName, info.isInverted)
      const tex = gl.createTexture()
      if (!tex) continue
      gl.bindTexture(gl.TEXTURE_2D, tex)
      setTexParams(gl, gl.TEXTURE_2D, gl.LINEAR)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        lutData,
      )
      this._colorbars.push(tex)
    }
  }

  getColorbarInfos(): ColorbarInfo[] {
    return this._colorbarInfos
  }

  configure(_gl: WebGL2RenderingContext, options: ColorbarOptions = {}): void {
    this.applyOptions(options)
  }

  draw(gl: WebGL2RenderingContext, _pass: unknown): void {
    if (!this.isReady || this._colorbars.length === 0 || !this._shader) return

    this._shader.use(gl)

    // Set common uniforms once
    const { rects } = colorbarGridLayout(this._colorbarInfos, this.getLayout())
    const barH = rects.length > 0 ? rects[0].h : 0
    if (this._shader.uniforms.canvasSize)
      gl.uniform2f(
        this._shader.uniforms.canvasSize,
        this._canvasWidth,
        this._canvasHeight,
      )
    if (this._shader.uniforms.opacity)
      gl.uniform1f(this._shader.uniforms.opacity, this._opacity)
    if (this._shader.uniforms.radiusPx)
      gl.uniform1f(this._shader.uniforms.radiusPx, barH * 0.5)
    if (this._shader.uniforms.borderPx)
      gl.uniform1f(this._shader.uniforms.borderPx, Math.ceil(barH / 15))
    if (this._shader.uniforms.borderColor) {
      gl.uniform4f(
        this._shader.uniforms.borderColor,
        this._borderColor[0],
        this._borderColor[1],
        this._borderColor[2],
        this._borderColor[3],
      )
    }

    // Disable depth for overlay
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    for (let i = 0; i < this._colorbars.length; i++) {
      const r = rects[i]
      if (this._shader.uniforms.rect) {
        gl.uniform4f(this._shader.uniforms.rect, r.x, r.y, r.w, r.h)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this._colorbars[i])
      if (this._shader.uniforms.colormapTex)
        gl.uniform1i(this._shader.uniforms.colormapTex, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // Restore state
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }

  hasColorbar(): boolean {
    return this._colorbars.length > 0
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    for (const tex of this._colorbars) {
      gl.deleteTexture(tex)
    }
    this._colorbars = []
    if (this._shader?.program) {
      gl.deleteProgram(this._shader.program)
    }
    this._shader = null
    this.isReady = false
    this._gl = null
  }
}
