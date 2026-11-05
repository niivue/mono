import type { LineData } from '@/view/NVLine'
import { NVRenderer } from '@/view/NVRenderer'
import lineShaderCode from './line.wgsl?raw'
import {
  alphaPipelineDesc,
  overlayDepth,
  uniformBuffer,
  uniformStorageEntries,
} from './pipeline'

export class LineRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  paramsBuffer: GPUBuffer | null

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.paramsBuffer = null
  }

  /** `depthFormat` null: for a pass with no depth attachment (the slide pane). */
  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    depthFormat: GPUTextureFormat | null = 'depth24plus',
  ): Promise<void> {
    if (this.isReady) return
    this.paramsBuffer = uniformBuffer(device, 16)
    this.bindLayout = device.createBindGroupLayout({
      entries: uniformStorageEntries(GPUShaderStage.VERTEX),
    })
    this.pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: lineShaderCode }),
        bindGroupLayouts: [this.bindLayout],
        format,
        msaaCount,
        depthStencil: depthFormat ? overlayDepth(depthFormat) : undefined,
      }),
    )
    this.isReady = true
  }

  resize(device: GPUDevice, width: number, height: number): void {
    if (!this.isReady || !this.paramsBuffer) return
    device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([width, height]),
    )
  }

  createBindGroup(
    device: GPUDevice,
    lineStorageBuffer: GPUBuffer,
  ): GPUBindGroup | null {
    if (!this.isReady || !this.bindLayout || !this.paramsBuffer) return null
    return device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: lineStorageBuffer } },
      ],
    })
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    bindGroup: GPUBindGroup | null,
    lineStorageBuffer: GPUBuffer,
    lines: LineData[],
    maxLines: number,
  ): void {
    if (!this.isReady || lines.length === 0 || !bindGroup || !this.pipeline)
      return
    const n = Math.min(lines.length, maxLines)
    const allLineData = new Float32Array(maxLines * 12)
    for (let i = 0; i < n; i++) allLineData.set(lines[i].data, i * 12)
    device.queue.writeBuffer(lineStorageBuffer, 0, allLineData)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(4, n)
  }

  destroy(): void {
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    this.pipeline = null
    this.bindLayout = null
    this.isReady = false
  }
}
