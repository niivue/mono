// UIKit's own WebGL2 line renderer. Self-contained (its own program + VAO +
// instance buffer) so UIKit draws without touching niivue core. Lazily initialized
// from the live context handed in by the overlay hook, and re-initialized if the
// context identity changes (backend switch / context loss). Duplicated in spirit
// from niivue core gl/line.ts during the bake-in phase.

import { FLOATS_PER_LINE, type LineData } from '../line'
import { GL_LINE_FRAG, GL_LINE_VERT } from './shaders'

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('UIKit: failed to create shader')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`UIKit: line shader compile failed: ${info}`)
  }
  return shader
}

export class GlLineRenderer {
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
    const vert = compile(gl, gl.VERTEX_SHADER, GL_LINE_VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, GL_LINE_FRAG)
    const program = gl.createProgram()
    if (!program) throw new Error('UIKit: failed to create line program')
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`UIKit: line program link failed: ${info}`)
    }
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('UIKit: failed to create line buffers')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = FLOATS_PER_LINE * 4
    const aStart = gl.getAttribLocation(program, 'lineStart')
    const aEnd = gl.getAttribLocation(program, 'lineEnd')
    const aThickness = gl.getAttribLocation(program, 'lineThickness')
    const aColor = gl.getAttribLocation(program, 'lineColor')
    gl.enableVertexAttribArray(aStart)
    gl.vertexAttribPointer(aStart, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(aStart, 1)
    gl.enableVertexAttribArray(aEnd)
    gl.vertexAttribPointer(aEnd, 2, gl.FLOAT, false, stride, 8)
    gl.vertexAttribDivisor(aEnd, 1)
    gl.enableVertexAttribArray(aThickness)
    gl.vertexAttribPointer(aThickness, 1, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(aThickness, 1)
    gl.enableVertexAttribArray(aColor)
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 32)
    gl.vertexAttribDivisor(aColor, 1)
    gl.bindVertexArray(null)
    this.gl = gl
    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
  }

  /** Draw `lines` in screen-pixel space over a `width` x `height` bounds rect. */
  draw(
    gl: WebGL2RenderingContext,
    lines: LineData[],
    width: number,
    height: number,
  ): void {
    if (lines.length === 0) return
    this.ensure(gl)
    if (!this.program || !this.vao || !this.buffer) return
    const need = lines.length * FLOATS_PER_LINE
    if (this.scratch.length < need) {
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2))
    }
    const data = this.scratch
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const off = i * FLOATS_PER_LINE
      // Zero a null/hole slot: the reused scratch may hold a prior frame's line
      // there, and drawArraysInstanced still draws it. A zeroed instance is a
      // degenerate, zero-thickness (invisible) line, matching a fresh alloc.
      if (line) data.set(line.data, off)
      else data.fill(0, off, off + FLOATS_PER_LINE)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    // Upload only the `need` used floats (scratch may be larger from a prior draw).
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW, 0, need)
    gl.useProgram(this.program)
    if (this.uCanvasSize) gl.uniform2f(this.uCanvasSize, width, height)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lines.length)
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
