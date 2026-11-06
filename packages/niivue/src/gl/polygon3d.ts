import type { Annotation3DRenderData } from '@/view/NVAnnotation'
import { NVRenderer } from '@/view/NVRenderer'
import {
  createIndexedGeometry,
  deleteGLObjects,
  type IndexedGeometry,
  uploadIndexed,
} from './glUtil'
import { polygon3dFragShader, polygon3dVertShader } from './polygon3dShader'
import { Shader } from './shader'

export class Polygon3DRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _geom: IndexedGeometry | null = null

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    // x, y, z, r, g, b, a
    this._geom = createIndexedGeometry(gl, [3, 4])
    this._shader = new Shader(gl, polygon3dVertShader, polygon3dFragShader)
    this.isReady = true
  }

  private _drawPass(
    gl: WebGL2RenderingContext,
    geom: IndexedGeometry,
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

    gl.bindVertexArray(geom.vao)
    gl.drawElements(gl.TRIANGLES, data.indices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  draw(
    gl: WebGL2RenderingContext,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
  ): void {
    if (!this.isReady || !this._shader || !this._geom) return
    if (data.vertices.length === 0 || data.indices.length === 0) return

    // Upload once — shared by draw and drawXRay
    uploadIndexed(gl, this._geom, data.vertices, data.indices)

    this._drawPass(gl, this._geom, data, mvpMatrix, gl.LESS, 1.0)
  }

  drawXRay(
    gl: WebGL2RenderingContext,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
    opacityMul: number,
  ): void {
    if (!this.isReady || !this._shader || !this._geom) return
    // Buffers already uploaded by draw() — just change depth func and opacity
    this._drawPass(gl, this._geom, data, mvpMatrix, gl.GREATER, opacityMul)
  }

  /** Must be called after both draw passes to restore GL state */
  endPasses(gl: WebGL2RenderingContext): void {
    gl.enable(gl.CULL_FACE)
    gl.depthFunc(gl.LESS)
    gl.depthMask(true)
  }

  destroy(): void {
    const gl = this._gl
    const geom = this._geom
    if (!gl || !geom) return
    deleteGLObjects(gl, this._shader, geom.vao, geom.vbo, geom.ibo)
    this._geom = null
    this._shader = null
    this._gl = null
    this.isReady = false
  }
}
