// The WebGL2 MSDF text renderer, for uikit's overlays and NiiVue core's labels
// alike: one instanced quad per glyph record (text/layout.ts FLOATS_PER_GLYPH).
// Self-contained; lazily initialized from the live context, and the atlas
// texture re-uploaded when the atlas source changes.

import { FLOATS_PER_GLYPH } from '../text/layout'
import { blendOver, linkProgram } from './glUtil'
import { GL_TEXT_FRAG, GL_TEXT_VERT } from './shaders'

/** An atlas image the text renderers upload: a decoded bitmap or a loaded `<img>`. */
export type UIKitAtlasSource = ImageBitmap | HTMLImageElement

export class GlTextRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private texture: WebGLTexture | null = null
  private atlas: UIKitAtlasSource | null = null
  private uCanvasSize: WebGLUniformLocation | null = null
  private uTexSize: WebGLUniformLocation | null = null
  private uFontTexture: WebGLUniformLocation | null = null

  private ensureProgram(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const program = linkProgram(gl, GL_TEXT_VERT, GL_TEXT_FRAG, 'text')
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('UIKit: failed to create text buffers')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = FLOATS_PER_GLYPH * 4
    const attrs: [string, number][] = [
      ['glyphRect', 0],
      ['glyphUvRect', 16],
      ['glyphColor', 32],
      ['glyphParams', 48],
    ]
    for (const [name, offset] of attrs) {
      const loc = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, offset)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    this.gl = gl
    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
    this.uTexSize = gl.getUniformLocation(program, 'texSize')
    this.uFontTexture = gl.getUniformLocation(program, 'fontTexture')
  }

  private ensureTexture(
    gl: WebGL2RenderingContext,
    atlas: UIKitAtlasSource,
  ): void {
    if (this.texture && this.atlas === atlas) return
    if (this.texture) gl.deleteTexture(this.texture)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas)
    this.texture = texture
    this.atlas = atlas
  }

  /**
   * Draw `count` glyph records from `glyphs` (screen pixels) over a `width` x
   * `height` bounds rect, in one instanced draw.
   */
  draw(
    gl: WebGL2RenderingContext,
    atlas: UIKitAtlasSource,
    glyphs: Float32Array,
    count: number,
    width: number,
    height: number,
  ): void {
    if (count === 0) return
    this.ensureProgram(gl)
    this.ensureTexture(gl, atlas)
    if (!this.program || !this.vao || !this.buffer || !this.texture) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      glyphs,
      gl.DYNAMIC_DRAW,
      0,
      count * FLOATS_PER_GLYPH,
    )
    gl.useProgram(this.program)
    if (this.uCanvasSize) gl.uniform2f(this.uCanvasSize, width, height)
    if (this.uTexSize) gl.uniform2f(this.uTexSize, atlas.width, atlas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (this.uFontTexture) gl.uniform1i(this.uFontTexture, 0)
    // The quad winds clockwise on screen: draw with culling off, then put the
    // host's state back.
    const cull = gl.isEnabled(gl.CULL_FACE)
    gl.disable(gl.CULL_FACE)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    blendOver(gl)
    gl.bindVertexArray(this.vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    gl.bindVertexArray(null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
    if (cull) gl.enable(gl.CULL_FACE)
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
    this.atlas = null
    this.uCanvasSize = null
    this.uTexSize = null
    this.uFontTexture = null
  }
}
