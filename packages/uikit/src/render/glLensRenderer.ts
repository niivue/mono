// UIKit's WebGL2 magnifier lens: blits the frame drawn so far (the overlay
// hook's bounds rect of the bound framebuffer) into a texture, then draws it
// enlarged in a circle. The blit resolves a multisampled canvas, which a
// texture read could not. A multisampled blit must keep its rectangle (WebGL2
// rejects any offset or scale with INVALID_OPERATION), so the texture covers
// the canvas from its origin to the bounds rect, the rect lands at its own
// coordinates, and the shader samples it there. Lenses on one context share
// one copy per frame, as WebGPU's captureScene does: a lens drawn after another
// shows the scene, not the earlier lens enlarged again.

import type { UIKitOverlayBounds } from '../hook'
import type { MagnifierLayout } from '../magnifier'
import { linkProgram } from './glUtil'
import { GL_IMAGE_VERT, GL_LENS_FRAG } from './shaders'

interface SceneCopy {
  texture: WebGLTexture | null
  fbo: WebGLFramebuffer | null
  width: number
  height: number
  // Bottom-up canvas y of the bounds rect's lower edge, where it sits in the texture.
  y0: number
  // The overlay frame last copied (a host builds a new frame object per draw).
  frame: object | null
  users: number
}
const copies = new WeakMap<WebGL2RenderingContext, SceneCopy>()

export class GlLensRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  // Empty VAO: the quad comes from gl_VertexID, and the host's bound VAO must not leak in.
  private vao: WebGLVertexArrayObject | null = null
  private copy: SceneCopy | null = null
  private u: Record<string, WebGLUniformLocation | null> = {}

  private ensure(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const program = linkProgram(gl, GL_IMAGE_VERT, GL_LENS_FRAG, 'lens')
    this.gl = gl
    this.program = program
    this.vao = gl.createVertexArray()
    let copy = copies.get(gl)
    if (!copy) {
      copy = {
        texture: null,
        fbo: gl.createFramebuffer(),
        width: 0,
        height: 0,
        y0: 0,
        frame: null,
        users: 0,
      }
      copies.set(gl, copy)
    }
    copy.users++
    this.copy = copy
    for (const name of [
      'canvasSize',
      'box',
      'lens',
      'fill',
      'imageSize',
      'imageRect',
      'image',
    ])
      this.u[name] = gl.getUniformLocation(program, name)
  }

  private capture(
    gl: WebGL2RenderingContext,
    b: UIKitOverlayBounds,
    copy: SceneCopy,
    frame: object,
  ): void {
    if (copy.frame === frame) return
    copy.frame = frame
    const { width, height } = b
    // shortcut: assumes the hook draws to the canvas (true of every core view);
    // an offscreen target would need its own height here.
    const y0 = gl.drawingBufferHeight - b.y - height
    // The part of the rect on the canvas: a canvas viewport can pan a view
    // partly off it, and the shader fills what was not copied.
    const x0 = Math.max(0, b.x)
    const x1 = Math.min(gl.drawingBufferWidth, b.x + width)
    const y1 = Math.min(gl.drawingBufferHeight, y0 + height)
    const yLow = Math.max(0, y0)
    // Grow only (views sharing a canvas, and so this copy, differ in extent),
    // capped at the canvas: a texture kept from a larger one samples stale texels.
    const texWidth = Math.max(
      1,
      Math.min(gl.drawingBufferWidth, Math.max(x1, copy.width)),
    )
    const texHeight = Math.max(
      1,
      Math.min(gl.drawingBufferHeight, Math.max(y1, copy.height)),
    )
    copy.y0 = y0
    if (!copy.texture || copy.width !== texWidth || copy.height !== texHeight) {
      // A multisample resolve needs the canvas's own format: RGB8 without alpha.
      const rgb = gl.getContextAttributes()?.alpha === false
      copy.texture ??= gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, copy.texture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        rgb ? gl.RGB8 : gl.RGBA8,
        texWidth,
        texHeight,
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
      copy.width = texWidth
      copy.height = texHeight
    }
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const scissor = gl.isEnabled(gl.SCISSOR_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, draw)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, copy.fbo)
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      copy.texture,
      0,
    )
    if (x1 > x0 && y1 > yLow)
      gl.blitFramebuffer(
        x0,
        yLow,
        x1,
        y1,
        x0,
        yLow,
        x1,
        y1,
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
    frame: object,
  ): void {
    this.ensure(gl)
    const { copy, program } = this
    if (!copy || !program) return
    this.capture(gl, bounds, copy, frame)
    if (!copy.texture) return
    const { u } = this
    const { lens } = layout
    gl.useProgram(program)
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
    gl.uniform4f(u.imageRect, bounds.x, copy.y0, copy.width, copy.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, copy.texture)
    gl.uniform1i(u.image, 0)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this.gl
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao)
      if (this.program) gl.deleteProgram(this.program)
      const copy = this.copy
      if (copy && --copy.users === 0) {
        if (copy.texture) gl.deleteTexture(copy.texture)
        if (copy.fbo) gl.deleteFramebuffer(copy.fbo)
        copies.delete(gl)
      }
    }
    this.gl = null
    this.program = null
    this.vao = null
    this.copy = null
  }
}
