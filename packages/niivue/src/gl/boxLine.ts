import {
  type BoxTile,
  FLOATS_PER_BOX_EDGE,
  scissorRect,
} from '@/view/NVBoxEdges'
import { NVRenderer } from '@/view/NVRenderer'
import { boxLineFragShader, boxLineVertShader } from './boxLineShader'
import { deleteGLObjects } from './glUtil'
import { Shader } from './shader'

/** Draws world-space box edges on each 3D render tile, projected on the GPU. */
export class BoxLineRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _buffer: WebGLBuffer | null = null

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, boxLineVertShader, boxLineFragShader)
    this._vao = gl.createVertexArray()
    this._buffer = gl.createBuffer()
    if (!this._vao || !this._buffer)
      throw new Error('Failed to create box line buffers')
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer)
    const program = this._shader.program
    const stride = FLOATS_PER_BOX_EDGE * 4
    const attribs: [string, number, number][] = [
      ['lineStart', 3, 0],
      ['lineEnd', 3, 12],
      ['lineThickness', 1, 24],
      ['lineColor', 4, 32],
    ]
    for (const [name, size, offset] of attribs) {
      const loc = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    this.isReady = true
  }

  /**
   * Each tile is scissored to its rect within `clip` (GL pixels), so an edge
   * never bleeds into a neighbouring tile. The caller restores viewport and
   * scissor.
   */
  draw(
    gl: WebGL2RenderingContext,
    edges: Float32Array<ArrayBuffer>,
    tiles: BoxTile[],
    clip: number[],
  ): void {
    if (!this.isReady || !this._shader || !this._vao || tiles.length === 0)
      return
    const count = edges.length / FLOATS_PER_BOX_EDGE
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer)
    gl.bufferData(gl.ARRAY_BUFFER, edges, gl.DYNAMIC_DRAW)
    this._shader.use(gl)
    const { mvp, tileSize } = this._shader.uniforms
    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    gl.bindVertexArray(this._vao)
    for (const tile of tiles) {
      const scissor = scissorRect(tile.rect, clip)
      if (!scissor) continue
      const [x, y, w, h] = tile.rect
      gl.viewport(x, y, w, h)
      gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3])
      gl.uniformMatrix4fv(mvp, false, tile.mvp)
      gl.uniform2f(tileSize, w, h)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    }
    gl.bindVertexArray(null)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    deleteGLObjects(gl, this._shader, this._vao, this._buffer)
    this.isReady = false
    this._shader = null
    this._vao = null
    this._buffer = null
    this._gl = null
  }
}
