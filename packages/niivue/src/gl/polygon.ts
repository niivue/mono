import type { AnnotationRenderData } from '@/view/NVAnnotation'
import { NVRenderer } from '@/view/NVRenderer'
import {
  createIndexedGeometry,
  deleteGLObjects,
  type IndexedGeometry,
  uploadIndexed,
} from './glUtil'
import { polygonFragShader, polygonVertShader } from './polygonShader'
import { Shader } from './shader'

export class PolygonRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _geom: IndexedGeometry | null = null
  private _canvasWidth = 1
  private _canvasHeight = 1

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    // x, y, r, g, b, a
    this._geom = createIndexedGeometry(gl, [2, 4])
    this._shader = new Shader(gl, polygonVertShader, polygonFragShader)
    this.isReady = true
  }

  resize(_gl: WebGL2RenderingContext, width: number, height: number): void {
    this._canvasWidth = width
    this._canvasHeight = height
  }

  draw(gl: WebGL2RenderingContext, data: AnnotationRenderData): void {
    if (!this.isReady || !this._shader || !this._geom) return
    if (data.fillVertices.length === 0 || data.fillIndices.length === 0) return

    uploadIndexed(gl, this._geom, data.fillVertices, data.fillIndices)

    this._shader.use(gl)
    const canvasSize = this._shader.uniforms.canvasSize
    if (canvasSize)
      gl.uniform2f(canvasSize, this._canvasWidth, this._canvasHeight)

    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.CULL_FACE)

    gl.bindVertexArray(this._geom.vao)
    gl.drawElements(gl.TRIANGLES, data.fillIndices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)

    gl.enable(gl.CULL_FACE)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
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
