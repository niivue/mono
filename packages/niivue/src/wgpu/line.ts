import type { LineData } from '@/view/NVLine'
import { NVRenderer } from '@/view/NVRenderer'
import lineShaderCode from './line.wgsl?raw'

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

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return
    // Uniforms for canvas
    this.paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })

    const lineModule = device.createShaderModule({ code: lineShaderCode })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: msaaCount },
      vertex: { module: lineModule, entryPoint: 'vertex_main' },
      fragment: {
        module: lineModule,
        entryPoint: 'fragment_main',
        targets: [
          {
            format: format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
              },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: false,
        depthCompare: 'always',
        format: 'depth24plus',
      },
      primitive: { topology: 'triangle-strip' },
    })
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
    const allLineData = new Float32Array(maxLines * 12)
    for (let i = 0; i < lines.length; i++) {
      if (i >= maxLines) break
      allLineData.set(lines[i].data, i * 12)
    }
    device.queue.writeBuffer(lineStorageBuffer, 0, allLineData)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(4, lines.length)
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
