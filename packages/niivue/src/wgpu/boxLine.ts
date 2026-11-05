import {
  type BoxTile,
  FLOATS_PER_BOX_EDGE,
  scissorRect,
} from '@/view/NVBoxEdges'
import { NVRenderer } from '@/view/NVRenderer'
import shaderCode from './boxLine.wgsl?raw'
import { alphaPipelineDesc, overlayDepth, uniformBuffer } from './pipeline'

// One tile's uniforms (mvp + tileSize, 80 bytes) per slot; 256 is WebGPU's
// default minUniformBufferOffsetAlignment.
const SLOT_BYTES = 256

/** Draws world-space box edges on each 3D render tile, projected on the GPU. */
export class BoxLineRenderer extends NVRenderer {
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private bindGroup: GPUBindGroup | null = null
  private edgeBuffer: GPUBuffer | null = null
  private tileBuffer: GPUBuffer | null = null

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })
    this.pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode }),
        bindGroupLayouts: [this.bindLayout],
        format,
        msaaCount,
        depthStencil: overlayDepth(),
      }),
    )
    this.isReady = true
  }

  /**
   * Each tile is scissored to its rect within the `width` x `height` target,
   * so an edge never bleeds into a neighbouring tile. The caller restores
   * viewport and scissor.
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    edges: Float32Array<ArrayBuffer>,
    tiles: BoxTile[],
    width: number,
    height: number,
  ): void {
    if (!this.isReady || !this.pipeline || !this.bindLayout) return
    if (tiles.length === 0) return
    const tileBytes = tiles.length * SLOT_BYTES
    if (
      !this.edgeBuffer ||
      !this.tileBuffer ||
      this.edgeBuffer.size < edges.byteLength ||
      this.tileBuffer.size < tileBytes
    ) {
      this.edgeBuffer?.destroy()
      this.tileBuffer?.destroy()
      this.edgeBuffer = device.createBuffer({
        size: edges.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.tileBuffer = uniformBuffer(device, tileBytes)
      this.bindGroup = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.tileBuffer, size: 80 } },
          { binding: 1, resource: { buffer: this.edgeBuffer } },
        ],
      })
    }
    device.queue.writeBuffer(this.edgeBuffer, 0, edges)
    const slots = new Float32Array(tileBytes / 4)
    tiles.forEach((tile, i) => {
      slots.set(tile.mvp, (i * SLOT_BYTES) / 4)
      slots[(i * SLOT_BYTES) / 4 + 16] = tile.rect[2]
      slots[(i * SLOT_BYTES) / 4 + 17] = tile.rect[3]
    })
    device.queue.writeBuffer(this.tileBuffer, 0, slots)
    pass.setPipeline(this.pipeline)
    const count = edges.length / FLOATS_PER_BOX_EDGE
    tiles.forEach(({ rect }, i) => {
      const scissor = scissorRect(rect, [0, 0, width, height])
      if (!scissor) return
      pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1)
      pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3])
      pass.setBindGroup(0, this.bindGroup, [i * SLOT_BYTES])
      pass.draw(4, count)
    })
  }

  destroy(): void {
    this.edgeBuffer?.destroy()
    this.tileBuffer?.destroy()
    this.edgeBuffer = null
    this.tileBuffer = null
    this.bindGroup = null
    this.pipeline = null
    this.bindLayout = null
    this.isReady = false
  }
}
