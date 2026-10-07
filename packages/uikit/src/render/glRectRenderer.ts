// UIKit's own WebGL2 rounded-rect renderer: the line renderer's instanced-quad
// model with the rect record layout. Self-contained and lazily initialized from
// the live context handed in by the overlay hook; re-initialized if the context
// identity changes (backend switch / context loss).

import { FLOATS_PER_RECT, type RectData } from '../rect'
import { GL_RECT_FRAG, GL_RECT_VERT } from './shaders'

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('UIKit: failed to create rect shader')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`UIKit: rect shader compile failed: ${info}`)
  }
  return shader
}

// Per-instance attributes: name, float count, byte offset into the record.
const ATTRIBUTES: ReadonlyArray<readonly [string, number, number]> = [
  ['rectPos', 2, 0],
  ['rectSize', 2, 8],
  ['rectShape', 2, 16],
  ['rectFill', 4, 32],
  ['rectBorder', 4, 48],
]

export class GlRectRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private uCanvasSize: WebGLUniformLocation | null = null
  // Reused instance-data scratch, grown as needed, to avoid a per-frame alloc.
  private scratch = new Float32Array(0)

  private ensure(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const vert = compile(gl, gl.VERTEX_SHADER, GL_RECT_VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, GL_RECT_FRAG)
    const program = gl.createProgram()
    if (!program) throw new Error('UIKit: failed to create rect program')
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`UIKit: rect program link failed: ${info}`)
    }
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('UIKit: failed to create rect buffers')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = FLOATS_PER_RECT * 4
    for (const [name, size, offset] of ATTRIBUTES) {
      const loc = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    this.gl = gl
    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
  }

  /** Draw `rects` in screen-pixel space over a `width` x `height` bounds rect. */
  draw(
    gl: WebGL2RenderingContext,
    rects: RectData[],
    width: number,
    height: number,
  ): void {
    if (rects.length === 0) return
    this.ensure(gl)
    if (!this.program || !this.vao || !this.buffer) return
    const need = rects.length * FLOATS_PER_RECT
    if (this.scratch.length < need) {
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2))
    }
    const data = this.scratch
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i]
      const off = i * FLOATS_PER_RECT
      // A zeroed slot is a zero-size (invisible) rect, matching a fresh alloc.
      if (rect) data.set(rect.data, off)
      else data.fill(0, off, off + FLOATS_PER_RECT)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW, 0, need)
    gl.useProgram(this.program)
    if (this.uCanvasSize) gl.uniform2f(this.uCanvasSize, width, height)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rects.length)
    gl.bindVertexArray(null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this.gl
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao)
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.gl = null
    this.program = null
    this.vao = null
    this.buffer = null
    this.uCanvasSize = null
  }
}
