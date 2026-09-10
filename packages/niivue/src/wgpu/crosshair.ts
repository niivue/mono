import type NVModel from '@/NVModel'
import { getAxisColor } from '@/view/crosshairColor'
import {
  applyCrosshairOffset,
  crosshairExplodeOffsetForModel,
} from '@/view/crosshairExplode'
import {
  BYTES_PER_VERTEX,
  buildVertexData,
  calculateCrosshairSegments,
  getCylinderIndices,
  MAX_CROSSHAIR_TILES,
  packColor,
  shouldCullCylinder,
  VERTS_PER_CYLINDER,
} from '@/view/NVCrosshair'
import { NVRenderer } from '@/view/NVRenderer'
import * as mesh from './mesh'

export type CrosshairResources = {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup | null
  indexCount: number
  alignedMeshSize: number
}

// One cylinder's vertices for one tile. A multiple of 4, as WebGPU requires of
// a setVertexBuffer offset.
const CROSSHAIR_SLOT_BYTES = VERTS_PER_CYLINDER * BYTES_PER_VERTEX

/** Byte offset of a crosshair vertex slot, clamped to the allocated range. */
function crosshairSlotOffset(slot: number): number {
  const clamped = Math.min(
    Math.max(0, Math.trunc(slot)),
    MAX_CROSSHAIR_TILES - 1,
  )
  return clamped * CROSSHAIR_SLOT_BYTES
}

export class CrosshairRenderer extends NVRenderer {
  private device: GPUDevice | null = null
  private cylinders: CrosshairResources[] = []
  private _uniformScratch = new Float32Array(mesh.MESH_UNIFORM_SIZE / 4)

  init(device: GPUDevice, bindGroupLayout: GPUBindGroupLayout): void {
    this.device = device
    this.destroy()

    const indices = getCylinderIndices()

    // Create 6 cylinders (2 per axis: X-, X+, Y-, Y+, Z-, Z+)
    for (let i = 0; i < 6; i++) {
      // Create vertex buffer with COPY_DST for dynamic updates. One slot per
      // distinct crosshair thickness the frame can need: queue writes do not
      // take effect between draws in a submitted pass, so a per-tile radius has
      // to live in its own region rather than overwrite a shared one.
      const vertexBuffer = device.createBuffer({
        size: CROSSHAIR_SLOT_BYTES * MAX_CROSSHAIR_TILES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })

      // Create index buffer (static, same topology)
      const indexBuffer = device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(
        indexBuffer,
        0,
        indices.buffer,
        indices.byteOffset,
        indices.byteLength,
      )

      // Create uniform buffer for mesh transforms
      const uniformBuffer = device.createBuffer({
        size: mesh.alignedMeshSize * mesh.MAX_TILES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })

      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: uniformBuffer, size: mesh.MESH_UNIFORM_SIZE },
          },
        ],
      })

      this.cylinders.push({
        vertexBuffer,
        indexBuffer,
        uniformBuffer,
        bindGroup,
        indexCount: indices.length,
        alignedMeshSize: mesh.alignedMeshSize,
      })
    }

    this.isReady = true
  }

  /**
   * Write the six cylinders at `radiusMM` -- the world radius that renders
   * `ui.crosshairWidth` canvas pixels thick on the tile about to be drawn (see
   * `crosshairRadiusMM`) -- into vertex slot `slot`. Pass the same `slot` to
   * `draw`/`drawXRay` for that tile. Slots exist because every write here lands
   * before the frame's submit, so tiles cannot take turns with one region.
   */
  update(model: NVModel, radiusMM: number, slot = 0): void {
    if (!this.device || !this.isReady) return

    const { extentsMin, extentsMax, scene, ui } = model
    const radius = radiusMM
    const offset = crosshairSlotOffset(slot)
    const segments = calculateCrosshairSegments(
      extentsMin,
      extentsMax,
      scene.crosshairPos,
      ui.crosshairGap,
    )

    // When the active volume is a chunked/exploded plan, shift the crosshair onto
    // the displaced block it sits in so the marker tracks the explosion. The
    // block lookup is in volume texture fraction, so convert via mm.
    const off = crosshairExplodeOffsetForModel(model)

    // Update each cylinder's vertex buffer. Cylinders are ordered
    // X-, X+, Y-, Y+, Z-, Z+, so axis = floor(i / 2).
    for (let i = 0; i < 6; i++) {
      const colorPacked = packColor(
        getAxisColor(
          Math.floor(i / 2),
          ui.crosshairColor,
          ui.crosshairColorPerAxis,
        ),
      )
      const seg = segments[i]
      const start = applyCrosshairOffset(seg[0], off)
      const end = applyCrosshairOffset(seg[1], off)
      const vertexData = buildVertexData(start, end, radius, colorPacked)
      this.device.queue.writeBuffer(
        this.cylinders[i].vertexBuffer,
        offset,
        vertexData,
      )
    }
  }

  getCylinders(): CrosshairResources[] {
    return this.cylinders
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    tileIndex: number,
    sliceType: number,
    slot = 0,
  ): void {
    if (!this.isReady) return
    const crosshairs = this.cylinders
    const vertexOffset = crosshairSlotOffset(slot)
    const s = this._uniformScratch
    s.set(mvpMatrix as ArrayLike<number>, 0)
    s.set(normalMatrix as ArrayLike<number>, 16)
    s[36] = 1.0
    pass.setPipeline(pipeline)
    for (let cylIdx = 0; cylIdx < crosshairs.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue
      const cyl = crosshairs[cylIdx]
      if (!cyl.bindGroup || !cyl.vertexBuffer || !cyl.indexBuffer) continue
      const dynamicOffset = Math.trunc(tileIndex * cyl.alignedMeshSize)
      device.queue.writeBuffer(cyl.uniformBuffer, dynamicOffset, s)
      pass.setBindGroup(0, cyl.bindGroup, [dynamicOffset])
      pass.setVertexBuffer(0, cyl.vertexBuffer, vertexOffset)
      pass.setIndexBuffer(cyl.indexBuffer, 'uint32')
      pass.drawIndexed(cyl.indexCount)
    }
  }

  drawXRay(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    xrayPipeline: GPURenderPipeline,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    tileIndex: number,
    sliceType: number,
    xrayAlpha: number,
    slot = 0,
  ): void {
    if (!this.isReady) return
    const crosshairs = this.cylinders
    const vertexOffset = crosshairSlotOffset(slot)
    const s = this._uniformScratch
    s.set(mvpMatrix as ArrayLike<number>, 0)
    s.set(normalMatrix as ArrayLike<number>, 16)
    s[36] = xrayAlpha
    for (let cylIdx = 0; cylIdx < crosshairs.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue
      const cyl = crosshairs[cylIdx]
      if (!cyl.bindGroup || !cyl.vertexBuffer || !cyl.indexBuffer) continue
      const dynamicOffset = Math.trunc(tileIndex * cyl.alignedMeshSize)
      device.queue.writeBuffer(cyl.uniformBuffer, dynamicOffset, s)
      pass.setPipeline(xrayPipeline)
      pass.setBindGroup(0, cyl.bindGroup, [dynamicOffset])
      pass.setVertexBuffer(0, cyl.vertexBuffer, vertexOffset)
      pass.setIndexBuffer(cyl.indexBuffer, 'uint32')
      pass.drawIndexed(cyl.indexCount)
    }
  }

  destroy(): void {
    for (const cyl of this.cylinders) {
      cyl.vertexBuffer.destroy()
      cyl.indexBuffer.destroy()
      cyl.uniformBuffer.destroy()
    }
    this.cylinders = []
    this.isReady = false
  }
}
