import type { Annotation3DRenderData } from '@/view/NVAnnotation'
import { NVRenderer } from '@/view/NVRenderer'
import { alphaPipelineDesc, uniformBuffer, uniformEntry } from './pipeline'
import shaderCode from './polygon3d.wgsl?raw'

// Uniform: mat4x4f (64 bytes) + f32 opacityMultiplier (4 bytes) + 12 bytes padding = 80 bytes
const UNIFORM_SIZE = 80
const GROWTH_FACTOR = 2

export class Polygon3DRenderer extends NVRenderer {
  private _pipeline: GPURenderPipeline | null = null
  private _xrayPipeline: GPURenderPipeline | null = null
  private _uniformBuffer: GPUBuffer | null = null
  private _xrayUniformBuffer: GPUBuffer | null = null
  private _bindGroupLayout: GPUBindGroupLayout | null = null
  private _bindGroup: GPUBindGroup | null = null
  private _xrayBindGroup: GPUBindGroup | null = null
  private _vertexBuffer: GPUBuffer | null = null
  private _indexBuffer: GPUBuffer | null = null
  private _maxVertexBytes = 0
  private _maxIndexBytes = 0
  private _uniformData = new Float32Array(UNIFORM_SIZE / 4)

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return

    this._uniformBuffer = uniformBuffer(device, UNIFORM_SIZE)
    this._xrayUniformBuffer = uniformBuffer(device, UNIFORM_SIZE)

    this._bindGroupLayout = device.createBindGroupLayout({
      entries: [uniformEntry(GPUShaderStage.VERTEX)],
    })

    this._bindGroup = device.createBindGroup({
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
    })

    this._xrayBindGroup = device.createBindGroup({
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._xrayUniformBuffer } }],
    })

    const desc = alphaPipelineDesc(device, {
      module: device.createShaderModule({ code: shaderCode }),
      bindGroupLayouts: [this._bindGroupLayout],
      format,
      msaaCount,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      buffers: [
        {
          arrayStride: 28, // 7 floats: x, y, z, r, g, b, a
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x4' },
          ],
        },
      ],
    })
    const depth = (depthCompare: GPUCompareFunction): GPUDepthStencilState => ({
      depthWriteEnabled: false,
      depthCompare,
      format: 'depth24plus',
    })
    // Normal pass: depth less; x-ray pass: depth greater (only occluded fragments)
    this._pipeline = device.createRenderPipeline({
      ...desc,
      depthStencil: depth('less'),
    })
    this._xrayPipeline = device.createRenderPipeline({
      ...desc,
      depthStencil: depth('greater'),
    })

    this.isReady = true
  }

  private _uploadBuffers(
    device: GPUDevice,
    data: Annotation3DRenderData,
  ): void {
    const vertexBytes = data.vertices.byteLength
    const indexBytes = data.indices.byteLength

    if (!this._vertexBuffer || vertexBytes > this._maxVertexBytes) {
      if (this._vertexBuffer) this._vertexBuffer.destroy()
      this._maxVertexBytes = Math.max(vertexBytes * GROWTH_FACTOR, 256 * 28)
      this._vertexBuffer = device.createBuffer({
        size: this._maxVertexBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }

    if (!this._indexBuffer || indexBytes > this._maxIndexBytes) {
      if (this._indexBuffer) this._indexBuffer.destroy()
      this._maxIndexBytes = Math.max(indexBytes * GROWTH_FACTOR, 512 * 4)
      this._indexBuffer = device.createBuffer({
        size: this._maxIndexBytes,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
    }

    device.queue.writeBuffer(
      this._vertexBuffer,
      0,
      data.vertices as Float32Array<ArrayBuffer>,
    )
    device.queue.writeBuffer(
      this._indexBuffer,
      0,
      data.indices as Uint32Array<ArrayBuffer>,
    )
  }

  private _writeUniform(
    device: GPUDevice,
    buffer: GPUBuffer,
    mvpMatrix: Float32Array,
    opacityMul: number,
  ): void {
    this._uniformData.set(mvpMatrix, 0)
    this._uniformData[16] = opacityMul
    device.queue.writeBuffer(
      buffer,
      0,
      this._uniformData as Float32Array<ArrayBuffer>,
    )
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
  ): void {
    if (
      !this.isReady ||
      !this._pipeline ||
      !this._bindGroup ||
      !this._uniformBuffer
    )
      return
    if (data.vertices.length === 0 || data.indices.length === 0) return

    // Upload vertex/index data once — shared with drawXRay
    this._uploadBuffers(device, data)
    this._writeUniform(device, this._uniformBuffer, mvpMatrix, 1.0)

    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, this._bindGroup)
    pass.setVertexBuffer(0, this._vertexBuffer as GPUBuffer)
    pass.setIndexBuffer(this._indexBuffer as GPUBuffer, 'uint32')
    pass.drawIndexed(data.indices.length)
  }

  drawXRay(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    data: Annotation3DRenderData,
    mvpMatrix: Float32Array,
    opacityMul: number,
  ): void {
    if (
      !this.isReady ||
      !this._xrayPipeline ||
      !this._xrayBindGroup ||
      !this._xrayUniformBuffer
    )
      return
    if (data.vertices.length === 0 || data.indices.length === 0) return

    // Buffers already uploaded by draw() — only write x-ray uniform
    this._writeUniform(device, this._xrayUniformBuffer, mvpMatrix, opacityMul)

    pass.setPipeline(this._xrayPipeline)
    pass.setBindGroup(0, this._xrayBindGroup)
    pass.setVertexBuffer(0, this._vertexBuffer as GPUBuffer)
    pass.setIndexBuffer(this._indexBuffer as GPUBuffer, 'uint32')
    pass.drawIndexed(data.indices.length)
  }

  destroy(): void {
    if (this._vertexBuffer) {
      this._vertexBuffer.destroy()
      this._vertexBuffer = null
    }
    if (this._indexBuffer) {
      this._indexBuffer.destroy()
      this._indexBuffer = null
    }
    if (this._uniformBuffer) {
      this._uniformBuffer.destroy()
      this._uniformBuffer = null
    }
    if (this._xrayUniformBuffer) {
      this._xrayUniformBuffer.destroy()
      this._xrayUniformBuffer = null
    }
    this._pipeline = null
    this._xrayPipeline = null
    this._bindGroupLayout = null
    this._bindGroup = null
    this._xrayBindGroup = null
    this.isReady = false
  }
}
