// UIKit's WebGL2 image renderer: one textured quad at a canvas-pixel box.
// Lazily initialized from the live context like the rect renderer; the texture
// is re-uploaded only when the caller bumps `version` (or hands a new source).

import type { UIKitBox } from '../rect'
import { GL_IMAGE_FRAG, GL_IMAGE_VERT } from './shaders'

export type UIKitImageSource = ImageBitmap | OffscreenCanvas | HTMLCanvasElement

export function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('UIKit: failed to create image shader')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`UIKit: image shader compile failed: ${info}`)
  }
  return shader
}

export class GlImageRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  // Empty VAO: the quad comes from gl_VertexID, and the host's bound VAO must not leak in.
  private vao: WebGLVertexArrayObject | null = null
  private texture: WebGLTexture | null = null
  private source: UIKitImageSource | null = null
  private version = -1
  private uCanvasSize: WebGLUniformLocation | null = null
  private uBox: WebGLUniformLocation | null = null
  private uImage: WebGLUniformLocation | null = null

  private ensure(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const vert = compile(gl, gl.VERTEX_SHADER, GL_IMAGE_VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, GL_IMAGE_FRAG)
    const program = gl.createProgram()
    if (!program) throw new Error('UIKit: failed to create image program')
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`UIKit: image program link failed: ${info}`)
    }
    this.gl = gl
    this.program = program
    this.vao = gl.createVertexArray()
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
    this.uBox = gl.getUniformLocation(program, 'box')
    this.uImage = gl.getUniformLocation(program, 'image')
  }

  private ensureTexture(
    gl: WebGL2RenderingContext,
    source: UIKitImageSource,
    version: number,
  ): void {
    if (this.texture && this.source === source && this.version === version)
      return
    this.texture ??= gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.source = source
    this.version = version
  }

  /** Draw `source` stretched over `box` (canvas px) in a `width` x `height` canvas. */
  draw(
    gl: WebGL2RenderingContext,
    source: UIKitImageSource,
    version: number,
    box: UIKitBox,
    width: number,
    height: number,
  ): void {
    this.ensure(gl)
    this.ensureTexture(gl, source, version)
    if (!this.program || !this.texture) return
    gl.useProgram(this.program)
    gl.uniform2f(this.uCanvasSize, width, height)
    gl.uniform4f(this.uBox, box.x, box.y, box.width, box.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(this.uImage, 0)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this.gl
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao)
      if (this.texture) gl.deleteTexture(this.texture)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.gl = null
    this.program = null
    this.vao = null
    this.texture = null
    this.source = null
    this.version = -1
  }
}
