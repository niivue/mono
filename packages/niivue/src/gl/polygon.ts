import type { AnnotationRenderData } from '@/view/NVAnnotation'
import { NVRenderer } from '@/view/NVRenderer'
import { polygonFragShader, polygonVertShader } from './polygonShader'
import { Shader } from './shader'

export class PolygonRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _indexBuffer: WebGLBuffer | null = null
  private _canvasWidth = 1
  private _canvasHeight = 1

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, polygonVertShader, polygonFragShader)

    this._vao = gl.createVertexArray()
    if (!this._vao) throw new Error('Failed to create polygon VAO')

    this._vertexBuffer = gl.createBuffer()
    this._indexBuffer = gl.createBuffer()
    if (!this._vertexBuffer || !this._indexBuffer)
      throw new Error('Failed to create polygon buffers')

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)

    // Vertex layout: x, y, r, g, b, a (6 floats = 24 bytes)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0) // position
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8) // color

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)
    gl.bindVertexArray(null)

    this.isReady = true
  }

  resize(_gl: WebGL2RenderingContext, width: number, height: number): void {
    this._canvasWidth = width
    this._canvasHeight = height
  }

  draw(gl: WebGL2RenderingContext, data: AnnotationRenderData): void {
    if (
      !this.isReady ||
      !this._shader ||
      !this._vao ||
      !this._vertexBuffer ||
      !this._indexBuffer
    )
      return
    if (data.fillVertices.length === 0 || data.fillIndices.length === 0) return

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, data.fillVertices, gl.DYNAMIC_DRAW)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.fillIndices, gl.DYNAMIC_DRAW)

    this._shader.use(gl)
    const canvasSize = this._shader.uniforms.canvasSize
    if (canvasSize)
      gl.uniform2f(canvasSize, this._canvasWidth, this._canvasHeight)

    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.CULL_FACE)

    gl.bindVertexArray(this._vao)
    gl.drawElements(gl.TRIANGLES, data.fillIndices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)

    gl.enable(gl.CULL_FACE)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    if (this._vao) gl.deleteVertexArray(this._vao)
    if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
    if (this._indexBuffer) gl.deleteBuffer(this._indexBuffer)
    if (this._shader?.program) gl.deleteProgram(this._shader.program)
    this._vao = null
    this._vertexBuffer = null
    this._indexBuffer = null
    this._shader = null
    this._gl = null
    this.isReady = false
  }
}
