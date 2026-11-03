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
  // CPU staging reused across frames (grown on demand), as in the rect renderer.
  private scratch = new Float32Array(0)
  private readonly params = new Float32Array(4)

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
    depthFormat: GPUTextureFormat | undefined,
    lines: LineData[],
    width: number,
    height: number,
  ): void {
    if (lines.length === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureCapacity(device, lines.length)
    if (!this.pipeline || !this.bindGroup || !this.storageBuffer) return
    this.params[0] = width
    this.params[1] = height
    device.queue.writeBuffer(this.paramsBuffer as GPUBuffer, 0, this.params)
    const need = lines.length * FLOATS_PER_LINE
    if (this.scratch.length < need) {
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2))
    }
    const data = this.scratch
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const off = i * FLOATS_PER_LINE
      // Zero a hole: the reused scratch may hold a prior frame's line there. A
      // zeroed instance is a zero-thickness (invisible) line, like a fresh alloc.
      if (line) data.set(line.data, off)
      else data.fill(0, off, off + FLOATS_PER_LINE)
    }
    device.queue.writeBuffer(this.storageBuffer, 0, data, 0, need)
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
