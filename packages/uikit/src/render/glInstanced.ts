// The WebGL2 line and rounded-rect renderers, for uikit's overlays and NiiVue
// core's lines and label panels alike: one instanced 4-vertex strip per record,
// expanded in the vertex stage. Self-contained; lazily initialized from the
// live context and re-initialized if the context identity changes (backend
// switch / context loss).

import { FLOATS_PER_LINE, type LineData } from '../line'
import { FLOATS_PER_RECT, type RectData } from '../rect'
import { blendOver, linkProgram } from './glUtil'
import {
  GL_LINE_FRAG,
  GL_LINE_VERT,
  GL_RECT_FRAG,
  GL_RECT_VERT,
} from './shaders'

/** Per-instance attribute: name, float count, byte offset into the record. */
type Attribute = readonly [string, number, number]

class GlInstancedRenderer<T extends { data: Float32Array }> {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private uCanvasSize: WebGLUniformLocation | null = null
  // Reused instance-data scratch, grown as needed, to avoid a per-frame alloc.
  private scratch = new Float32Array(0)

  constructor(
    private readonly vert: string,
    private readonly frag: string,
    private readonly floats: number,
    private readonly attributes: readonly Attribute[],
    private readonly what: string,
  ) {}

  private ensure(gl: WebGL2RenderingContext): void {
    if (this.gl === gl && this.program) return
    if (this.gl && this.gl !== gl) this.destroy()
    const program = linkProgram(gl, this.vert, this.frag, this.what)
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer)
      throw new Error(`UIKit: failed to create ${this.what} buffers`)
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    for (const [name, size, offset] of this.attributes) {
      const loc = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(
        loc,
        size,
        gl.FLOAT,
        false,
        this.floats * 4,
        offset,
      )
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    this.gl = gl
    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uCanvasSize = gl.getUniformLocation(program, 'canvasSize')
  }

  /** Draw `records` in screen-pixel space over a `width` x `height` bounds rect. */
  draw(
    gl: WebGL2RenderingContext,
    records: readonly (T | undefined)[],
    width: number,
    height: number,
  ): void {
    if (records.length === 0) return
    this.ensure(gl)
    if (!this.program || !this.vao || !this.buffer) return
    const f = this.floats
    const need = records.length * f
    if (this.scratch.length < need)
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2))
    const data = this.scratch
    for (let i = 0; i < records.length; i++) {
      // Zero the slot first: a hole or a short record must not keep a prior
      // frame's record from the reused scratch (zeroed = invisible).
      data.fill(0, i * f, (i + 1) * f)
      const r = records[i]
      if (r) data.set(r.data, i * f)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW, 0, need)
    gl.useProgram(this.program)
    if (this.uCanvasSize) gl.uniform2f(this.uCanvasSize, width, height)
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    blendOver(gl)
    gl.bindVertexArray(this.vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, records.length)
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

export class GlLineRenderer extends GlInstancedRenderer<LineData> {
  constructor() {
    super(
      GL_LINE_VERT,
      GL_LINE_FRAG,
      FLOATS_PER_LINE,
      [
        ['lineStart', 2, 0],
        ['lineEnd', 2, 8],
        ['lineThickness', 1, 16],
        ['lineColor', 4, 32],
      ],
      'line',
    )
  }
}

export class GlRectRenderer extends GlInstancedRenderer<RectData> {
  constructor() {
    super(
      GL_RECT_VERT,
      GL_RECT_FRAG,
      FLOATS_PER_RECT,
      [
        ['rectPos', 2, 0],
        ['rectSize', 2, 8],
        ['rectShape', 2, 16],
        ['rectFill', 4, 32],
        ['rectBorder', 4, 48],
      ],
      'rect',
    )
  }
}
