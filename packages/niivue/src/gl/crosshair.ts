import type NVModel from '@/NVModel'
import type { NVMesh, WebGLMeshGPU } from '@/NVTypes'
import {
  BYTES_PER_VERTEX,
  buildVertexData,
  calculateCrosshairSegments,
  getCylinderIndices,
  packColor,
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

  update(model: NVModel): void {
    if (!this.gl || !this.isReady) return
    const gl = this.gl

    const { extentsMin, extentsMax, scene, ui } = model
    const radius = ui.crosshairWidth
    const colorPacked = packColor(ui.crosshairColor)
    const segments = calculateCrosshairSegments(
      extentsMin,
      extentsMax,
      scene.crosshairPos,
      ui.crosshairGap,
    )

    // Update each cylinder's vertex buffer
    for (let i = 0; i < 6; i++) {
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
