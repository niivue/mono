// UIKit's WebGL2 magnifier lens: blits the frame drawn so far (the overlay
// hook's bounds rect of the bound framebuffer) into a texture, then draws it
// enlarged in a circle. The blit resolves a multisampled canvas, which a
// texture read could not.

import type { UIKitOverlayBounds } from '@niivue/niivue'
import type { MagnifierLayout } from '../magnifier'
import { compile } from './glImageRenderer'
import { GL_IMAGE_VERT, GL_LENS_FRAG } from './shaders'

export class GlLensRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  // Empty VAO: the quad comes from gl_VertexID, and the host's bound VAO must not leak in.
  private vao: WebGLVertexArrayObject | null = null
  private texture: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private texWidth = 0
  private texHeight = 0
  private u: Record<string, WebGLUniformLocation | null> = {}

  private ensure(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const vert = compile(gl, gl.VERTEX_SHADER, GL_IMAGE_VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, GL_LENS_FRAG)
    const program = gl.createProgram()
    if (!program) throw new Error('UIKit: failed to create lens program')
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`UIKit: lens program link failed: ${info}`)
    }
    this.gl = gl
    this.program = program
    this.vao = gl.createVertexArray()
    this.fbo = gl.createFramebuffer()
    for (const name of [
      'canvasSize',
      'box',
      'lens',
      'fill',
      'imageSize',
      'image',
    ])
      this.u[name] = gl.getUniformLocation(program, name)
  }

  private capture(gl: WebGL2RenderingContext, b: UIKitOverlayBounds): void {
    const { width, height } = b
    if (!this.texture || this.texWidth !== width || this.texHeight !== height) {
      // A multisample resolve needs the canvas's own format: RGB8 without alpha.
      const rgb = gl.getContextAttributes()?.alpha === false
      this.texture ??= gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        rgb ? gl.RGB8 : gl.RGBA8,
        width,
        height,
        0,
        rgb ? gl.RGB : gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.bindTexture(gl.TEXTURE_2D, null)
      this.texWidth = width
      this.texHeight = height
    }
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const scissor = gl.isEnabled(gl.SCISSOR_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, draw)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    )
    // shortcut: assumes the hook draws to the canvas (true of every core view);
    // an offscreen target would need its own height here.
    const y0 = gl.drawingBufferHeight - b.y - height
    gl.blitFramebuffer(
      b.x,
      y0,
      b.x + width,
      y0 + height,
      0,
      0,
      width,
      height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    )
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
    if (scissor) gl.enable(gl.SCISSOR_TEST)
  }

  draw(
    gl: WebGL2RenderingContext,
    bounds: UIKitOverlayBounds,
    layout: MagnifierLayout,
    fill: readonly number[],
  ): void {
    this.ensure(gl)
    this.capture(gl, bounds)
    if (!this.program || !this.texture) return
    const { u } = this
    const { lens } = layout
    gl.useProgram(this.program)
    gl.uniform2f(u.canvasSize, bounds.width, bounds.height)
    gl.uniform4f(u.box, lens.x, lens.y, lens.width, lens.height)
    gl.uniform4f(
      u.lens,
      layout.centerX,
      layout.centerY,
      layout.radius,
      layout.zoom,
    )
    gl.uniform4f(u.fill, fill[0], fill[1], fill[2], fill[3])
    gl.uniform2f(u.imageSize, bounds.width, bounds.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(u.image, 0)
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
      if (this.fbo) gl.deleteFramebuffer(this.fbo)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.gl = null
    this.program = null
    this.vao = null
    this.texture = null
    this.fbo = null
    this.texWidth = 0
    this.texHeight = 0
  }
}
