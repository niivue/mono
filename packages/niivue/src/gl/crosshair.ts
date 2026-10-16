import { BYTES_PER_VERTEX, packColor } from '@/mesh/vertexFormat'
import type NVModel from '@/NVModel'
import type { NVMesh, WebGLMeshGPU } from '@/NVTypes'
import { getAxisColor } from '@/view/crosshairColor'
import {
  buildVertexData,
  crosshairSegmentsForTile,
  getCylinderIndices,
  shouldCullCylinder,
  VERTS_PER_CYLINDER,
} from '@/view/NVCrosshair'
import { NVRenderer } from '@/view/NVRenderer'
import * as mesh from './mesh'

export type CrosshairResources = WebGLMeshGPU & {
  shaderType: string
}

export class CrosshairRenderer extends NVRenderer {
  private gl: WebGL2RenderingContext | null = null
  private cylinders: CrosshairResources[] = []
  // radius, one packed colour per axis, 6 segments x 2 endpoints x 3 axes
  private _geometryKey = new Float64Array(1 + 3 + 36).fill(Number.NaN)

  /** True when the buffers do not already hold this geometry. */
  private _geometryChanged(
    radius: number,
    axisColors: ArrayLike<number>,
    segments: ReturnType<typeof crosshairSegmentsForTile>,
  ): boolean {
    const key = this._geometryKey
    let k = 0
    let changed = false
    const put = (v: number): void => {
      if (key[k] !== v) changed = true
      key[k++] = v
    }
    put(radius)
    put(axisColors[0])
    put(axisColors[1])
    put(axisColors[2])
    for (const seg of segments) {
      for (const pt of seg) {
        put(pt[0])
        put(pt[1])
        put(pt[2])
      }
    }
    return changed
  }

  init(
    gl: WebGL2RenderingContext,
    aPosition: number,
    aNormal: number,
    aColor: number,
  ): void {
    this.gl = gl
    this.destroy()

    const indices = getCylinderIndices()

    // Create 6 cylinders (2 per axis: X-, X+, Y-, Y+, Z-, Z+)
    for (let i = 0; i < 6; i++) {
      // Create VAO
      const vao = gl.createVertexArray()
      if (!vao) {
        throw new Error('Failed to create crosshair VAO')
      }
      gl.bindVertexArray(vao)

      // Create vertex buffer with DYNAMIC_DRAW for frequent updates
      const vertexBuffer = gl.createBuffer()
      if (!vertexBuffer) {
        gl.bindVertexArray(null)
        throw new Error('Failed to create crosshair vertex buffer')
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      // Allocate buffer with initial size, data will be written in update()
      gl.bufferData(
        gl.ARRAY_BUFFER,
        VERTS_PER_CYLINDER * BYTES_PER_VERTEX,
        gl.DYNAMIC_DRAW,
      )

      // Set up vertex attributes (interleaved, 28 bytes stride)
      gl.enableVertexAttribArray(aPosition)
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 28, 0)
      gl.enableVertexAttribArray(aNormal)
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 28, 12)
      gl.enableVertexAttribArray(aColor)
      gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, 28, 24)

      // Create index buffer (static, same topology)
      const indexBuffer = gl.createBuffer()
      if (!indexBuffer) {
        gl.bindVertexArray(null)
        throw new Error('Failed to create crosshair index buffer')
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

      gl.bindVertexArray(null)

      this.cylinders.push({
        vao,
        vertexBuffer,
        indexBuffer,
        indexCount: indices.length,
        shaderType: 'phong',
      })
    }

    this.isReady = true
  }

  /**
   * Rebuild the six cylinders at `radiusMM`, the world radius that renders
   * `ui.crosshairWidth` canvas pixels thick on the tile about to be drawn
   * (see `crosshairRadiusMM`), with arms placed for a tile of `sliceType`
   * (see `crosshairSegmentsForTile`). Call it immediately before each tile's
   * draw: unlike the WebGPU renderer this keeps a single buffer set, so the
   * last upload is what the next draw uses. Uploads are skipped when the
   * geometry matches the previous call's.
   */
  update(model: NVModel, radiusMM: number, sliceType: number): void {
    if (!this.gl || !this.isReady) return
    const gl = this.gl

    const { ui } = model
    const radius = radiusMM
    const segments = crosshairSegmentsForTile(model, sliceType)

    // Cylinders are ordered X-, X+, Y-, Y+, Z-, Z+, so axis = floor(i / 2).
    const axisColors = [0, 1, 2].map((axis) =>
      packColor(
        getAxisColor(axis, ui.crosshairColor, ui.crosshairColorPerAxis),
      ),
    )

    // Tiles that share a radius and slice plane share the geometry, so only the
    // first of them pays for the rebuild. Each 2D tile of an oblique volume has
    // its own plane, so those tiles rebuild in turn.
    if (!this._geometryChanged(radius, axisColors, segments)) return

    // Update each cylinder's vertex buffer
    for (let i = 0; i < 6; i++) {
      const colorPacked = axisColors[Math.floor(i / 2)]
      const [start, end] = segments[i]
      const vertexData = buildVertexData(start, end, radius, colorPacked)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cylinders[i].vertexBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  getCylinders(): CrosshairResources[] {
    return this.cylinders
  }

  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    normalMatrix: Float32Array,
    sliceType: number,
  ): void {
    if (!this.isReady) return
    for (let cylIdx = 0; cylIdx < this.cylinders.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue
      const cyl = this.cylinders[cylIdx]
      if (!cyl.vao) continue
      mesh.drawWithGpu(
        gl,
        { opacity: 1.0, shaderType: 'phong' } as NVMesh,
        cyl,
        mvpMatrix,
        normalMatrix,
        1.0,
        'phong',
      )
    }
  }

  drawXRay(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    normalMatrix: Float32Array,
    sliceType: number,
    xrayAlpha: number,
  ): void {
    if (!this.isReady) return
    for (let cylIdx = 0; cylIdx < this.cylinders.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue
      const cyl = this.cylinders[cylIdx]
      if (!cyl.vao) continue
      mesh.drawXRay(
        gl,
        { opacity: 1.0, shaderType: 'phong' } as NVMesh,
        cyl,
        mvpMatrix,
        normalMatrix,
        xrayAlpha,
        'phong',
      )
    }
  }

  destroy(): void {
    if (!this.gl) return
    const gl = this.gl

    for (const cyl of this.cylinders) {
      if (cyl.vao) gl.deleteVertexArray(cyl.vao)
      if (cyl.vertexBuffer) gl.deleteBuffer(cyl.vertexBuffer)
      if (cyl.indexBuffer) gl.deleteBuffer(cyl.indexBuffer)
    }
    this.cylinders = []
    this.isReady = false
  }
}
