// UIKit's own WebGPU rounded-rect renderer: the line renderer's model (a storage
// buffer of records, one instance each, drawn into the frame's open pass with a
// pipeline matched to the pass's attachment formats) with the rect record layout.

import { FLOATS_PER_RECT, type RectData } from '../rect'
import { WGSL_RECT } from './shaders'

const BYTES_PER_RECT = FLOATS_PER_RECT * 4

export class WgpuRectRenderer {
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
    depthFormat: GPUTextureFormat | undefined,
  ): void {
    const key = `${colorFormat}|${sampleCount}|${depthFormat ?? 'none'}`
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
    const module = device.createShaderModule({ code: WGSL_RECT })
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
      // Only declare depth-stencil when the target pass actually has a depth
      // attachment (the main NiiVue view does; the slide viewer does not).
      ...(depthFormat
        ? {
            depthStencil: {
              depthWriteEnabled: false,
              depthCompare: 'always' as const,
              format: depthFormat,
            },
          }
        : {}),
      primitive: { topology: 'triangle-strip' },
    })
    this.bindGroup = null
  }

  private ensureCapacity(device: GPUDevice, count: number): void {
    if (this.storageBuffer && this.capacity >= count && this.bindGroup) return
    this.capacity = Math.max(count, this.capacity, 64)
    this.storageBuffer?.destroy()
    this.storageBuffer = device.createBuffer({
      size: this.capacity * BYTES_PER_RECT,
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

  /** Append `rects` (screen-pixel space) to the open pass over a bounds rect. */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat | undefined,
    rects: RectData[],
    width: number,
    height: number,
  ): void {
    if (rects.length === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureCapacity(device, rects.length)
    if (!this.pipeline || !this.bindGroup || !this.storageBuffer) return
    device.queue.writeBuffer(
      this.paramsBuffer as GPUBuffer,
      0,
      new Float32Array([width, height]),
    )
    const data = new Float32Array(rects.length * FLOATS_PER_RECT)
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i]
      if (rect) data.set(rect.data, i * FLOATS_PER_RECT)
    }
    device.queue.writeBuffer(this.storageBuffer, 0, data)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(4, rects.length)
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
