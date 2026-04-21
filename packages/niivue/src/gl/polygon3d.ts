import type { Annotation3DRenderData } from '@/view/NVAnnotation'
import { NVRenderer } from '@/view/NVRenderer'
import { polygon3dFragShader, polygon3dVertShader } from './polygon3dShader'
import { Shader } from './shader'

export class Polygon3DRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _indexBuffer: WebGLBuffer | null = null

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, polygon3dVertShader, polygon3dFragShader)

    this._vao = gl.createVertexArray()
    if (!this._vao) throw new Error('Failed to create polygon3d VAO')

    this._vertexBuffer = gl.createBuffer()
    this._indexBuffer = gl.createBuffer()
    if (!this._vertexBuffer || !this._indexBuffer)
      throw new Error('Failed to create polygon3d buffers')

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)

    // Vertex layout: x, y, z, r, g, b, a (7 floats = 28 bytes)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0) // position
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12) // color

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)
    gl.bindVertexArray(null)

    this.isReady = true
  }

  private _drawPass(
    gl: WebGL2RenderingContext,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
    depthFunc: number,
    opacityMul: number,
  ): void {
    this._shader?.use(gl)
    const mvpLoc = this._shader?.uniforms.mvpMatrix
    if (mvpLoc) gl.uniformMatrix4fv(mvpLoc, false, mvpMatrix)
    const opLoc = this._shader?.uniforms.opacityMultiplier
    if (opLoc) gl.uniform1f(opLoc, opacityMul)

    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(depthFunc)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    )

    gl.bindVertexArray(this._vao)
    gl.drawElements(gl.TRIANGLES, data.indices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  draw(
    gl: WebGL2RenderingContext,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
  ): void {
    if (
      !this.isReady ||
      !this._shader ||
      !this._vao ||
      !this._vertexBuffer ||
      !this._indexBuffer
    )
      return
    if (data.vertices.length === 0 || data.indices.length === 0) return

    // Upload once — shared by draw and drawXRay
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.DYNAMIC_DRAW)

    this._drawPass(gl, data, mvpMatrix, gl.LESS, 1.0)
  }

  drawXRay(
    gl: WebGL2RenderingContext,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
    opacityMul: number,
  ): void {
    if (!this.isReady || !this._shader || !this._vao) return
    // Buffers already uploaded by draw() — just change depth func and opacity
    this._drawPass(gl, data, mvpMatrix, gl.GREATER, opacityMul)
  }

  /** Must be called after both draw passes to restore GL state */
  endPasses(gl: WebGL2RenderingContext): void {
    gl.enable(gl.CULL_FACE)
    gl.depthFunc(gl.LESS)
    gl.depthMask(true)
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
