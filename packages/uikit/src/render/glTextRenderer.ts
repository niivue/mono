// UIKit's own WebGL2 MSDF text renderer. Draws pre-transformed screen-pixel
// triangle vertices (rotation baked in by the CPU layout) with the atlas bound.
// Self-contained; lazily initialized from the live context and atlas image, and
// re-initialized if either identity changes.

import { FLOATS_PER_VERTEX } from '../text/layout'
import { GL_TEXT_FRAG, GL_TEXT_VERT } from './shaders'

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('UIKit: failed to create text shader')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`UIKit: text shader compile failed: ${info}`)
  }
  return shader
}

export class GlTextRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private texture: WebGLTexture | null = null
  private textureImage: ImageBitmap | null = null
  private uCanvasSize: WebGLUniformLocation | null = null
  private uScreenPxRange: WebGLUniformLocation | null = null
  private uFontTexture: WebGLUniformLocation | null = null
  private uOutlineColor: WebGLUniformLocation | null = null
  private uOutlineWidthPx: WebGLUniformLocation | null = null

  private ensureProgram(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const vert = compile(gl, gl.VERTEX_SHADER, GL_TEXT_VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, GL_TEXT_FRAG)
    const program = gl.createProgram()
    if (!program) throw new Error('UIKit: failed to create text program')
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`UIKit: text program link failed: ${info}`)
    }
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('UIKit: failed to create text buffers')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = FLOATS_PER_VERTEX * 4
    const aPos = gl.getAttribLocation(program, 'pos')
    const aUv = gl.getAttribLocation(program, 'uv')
    const aColor = gl.getAttribLocation(program, 'color')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 8)
    gl.enableVertexAttribArray(aColor)
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 16)
    gl.bindVertexArray(null)
    this.gl = gl
    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
    this.uScreenPxRange = gl.getUniformLocation(program, 'screenPxRange')
    this.uFontTexture = gl.getUniformLocation(program, 'fontTexture')
    this.uOutlineColor = gl.getUniformLocation(program, 'outlineColor')
    this.uOutlineWidthPx = gl.getUniformLocation(program, 'outlineWidthPx')
  }

  private ensureTexture(gl: WebGL2RenderingContext, image: ImageBitmap): void {
    if (this.texture && this.textureImage === image) return
    if (this.texture) gl.deleteTexture(this.texture)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.texture = texture
    this.textureImage = image
  }

  /** Draw one already-laid-out glyph run (screen-pixel vertices). */
  draw(
    gl: WebGL2RenderingContext,
    image: ImageBitmap,
    vertices: Float32Array,
    count: number,
    screenPxRange: number,
    width: number,
    height: number,
    outlineColor: readonly number[],
    outlineWidthPx: number,
  ): void {
    if (count === 0) return
    this.ensureProgram(gl)
    this.ensureTexture(gl, image)
    if (!this.program || !this.vao || !this.buffer || !this.texture) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.useProgram(this.program)
    if (this.uCanvasSize) gl.uniform2f(this.uCanvasSize, width, height)
    if (this.uScreenPxRange) gl.uniform1f(this.uScreenPxRange, screenPxRange)
    if (this.uOutlineColor) {
      gl.uniform4f(
        this.uOutlineColor,
        outlineColor[0] ?? 0,
        outlineColor[1] ?? 0,
        outlineColor[2] ?? 0,
        outlineColor[3] ?? 0,
      )
    }
    if (this.uOutlineWidthPx) gl.uniform1f(this.uOutlineWidthPx, outlineWidthPx)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (this.uFontTexture) gl.uniform1i(this.uFontTexture, 0)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, count)
    gl.bindVertexArray(null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this.gl
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao)
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.texture) gl.deleteTexture(this.texture)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.gl = null
    this.program = null
    this.vao = null
    this.buffer = null
    this.texture = null
    this.textureImage = null
    this.uCanvasSize = null
    this.uScreenPxRange = null
    this.uFontTexture = null
    this.uOutlineColor = null
    this.uOutlineWidthPx = null
  }
}
