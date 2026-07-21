// UIKit's own WebGPU line renderer. Self-contained (its own pipeline, bind group
// layout, uniform + storage buffers) so UIKit draws without touching niivue core.
// The pipeline is built to match the open render pass's attachment formats (color
// format, MSAA sample count, depth format) carried on the overlay handle, then
// appends its draw to that pass. Duplicated in spirit from niivue core wgpu/line.ts
// during the bake-in phase.

import { FLOATS_PER_LINE, type LineData } from '../line'
import { WGSL_LINE } from './shaders'

const BYTES_PER_LINE = FLOATS_PER_LINE * 4

export class WgpuLineRenderer {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private paramsBuffer: GPUBuffer | null = null
  private storageBuffer: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacity = 0
  private key = ''

  private ensurePipeline(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat,
  ): void {
    const key = `${colorFormat}|${sampleCount}|${depthFormat}`
    if (this.device === device && this.pipeline && this.key === key) return
    if (this.device && this.device !== device) this.destroy()
    this.device = device
    this.key = key
    this.paramsBuffer ??= device.createBuffer({
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
    const module = device.createShaderModule({ code: WGSL_LINE })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: sampleCount },
      vertex: { module, entryPoint: 'vertex_main' },
      fragment: {
        module,
        entryPoint: 'fragment_main',
        targets: [
          {
            format: colorFormat,
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
        format: depthFormat,
      },
      primitive: { topology: 'triangle-strip' },
    })
    // Bind group depends on the storage buffer; force a rebuild.
    this.bindGroup = null
  }

  private ensureCapacity(device: GPUDevice, count: number): void {
    if (this.storageBuffer && this.capacity >= count && this.bindGroup) return
    this.capacity = Math.max(count, this.capacity, 64)
    this.storageBuffer?.destroy()
    this.storageBuffer = device.createBuffer({
      size: this.capacity * BYTES_PER_LINE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    if (this.bindLayout && this.paramsBuffer) {
      this.bindGroup = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.storageBuffer } },
        ],
      })
    }
  }

  /** Append `lines` (screen-pixel space) to the open pass over a bounds rect. */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat,
    lines: LineData[],
    width: number,
    height: number,
  ): void {
    if (lines.length === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureCapacity(device, lines.length)
    if (!this.pipeline || !this.bindGroup || !this.storageBuffer) return
    device.queue.writeBuffer(
      this.paramsBuffer as GPUBuffer,
      0,
      new Float32Array([width, height]),
    )
    const data = new Float32Array(lines.length * FLOATS_PER_LINE)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line) data.set(line.data, i * FLOATS_PER_LINE)
    }
    device.queue.writeBuffer(this.storageBuffer, 0, data)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(4, lines.length)
  }

  destroy(): void {
    this.paramsBuffer?.destroy()
    this.storageBuffer?.destroy()
    this.device = null
    this.pipeline = null
    this.bindLayout = null
    this.paramsBuffer = null
    this.storageBuffer = null
    this.bindGroup = null
    this.capacity = 0
    this.key = ''
  }
}
