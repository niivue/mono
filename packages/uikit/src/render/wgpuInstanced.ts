// The WebGPU line and rounded-rect renderers, for uikit's overlays and NiiVue
// core's lines and label panels alike: a storage buffer of records (grown as
// needed), one instanced 4-vertex strip each, appended to the open pass with a
// pipeline matched to its attachment formats. One draw per renderer per pass:
// a second would overwrite the first's records before the pass runs.

import { FLOATS_PER_LINE, type LineData } from '../line'
import { FLOATS_PER_RECT, type RectData } from '../rect'
import { WGSL_LINE, WGSL_RECT } from './shaders'
import { overlayPipeline } from './wgpuUtil'

class WgpuInstancedRenderer<T extends { data: Float32Array }> {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private paramsBuffer: GPUBuffer | null = null
  private storageBuffer: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacity = 0
  private key = ''
  // CPU staging reused across frames (grown on demand) so an idle overlay
  // drawing every frame does not allocate per frame.
  private scratch = new Float32Array(0)
  private readonly params = new Float32Array(4)

  constructor(
    private readonly wgsl: string,
    private readonly floats: number,
  ) {}

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
    this.pipeline = overlayPipeline(
      device,
      device.createShaderModule({ code: this.wgsl }),
      this.bindLayout,
      colorFormat,
      sampleCount,
      depthFormat,
    )
    // The bind group depends on the layout; force a rebuild.
    this.bindGroup = null
  }

  private ensureCapacity(device: GPUDevice, count: number): void {
    if (this.storageBuffer && this.capacity >= count && this.bindGroup) return
    this.capacity = Math.max(count, this.capacity, 64)
    this.storageBuffer?.destroy()
    this.storageBuffer = device.createBuffer({
      size: this.capacity * this.floats * 4,
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

  /** Append `records` (screen-pixel space) to the open pass over a bounds rect. */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat | undefined,
    records: readonly (T | undefined)[],
    width: number,
    height: number,
  ): void {
    if (records.length === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureCapacity(device, records.length)
    if (!this.pipeline || !this.bindGroup || !this.storageBuffer) return
    this.params[0] = width
    this.params[1] = height
    device.queue.writeBuffer(this.paramsBuffer as GPUBuffer, 0, this.params)
    const f = this.floats
    const need = records.length * f
    if (this.scratch.length < need)
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2))
    const data = this.scratch
    for (let i = 0; i < records.length; i++) {
      // Zero the slot first: a hole or a short record (a 3-value colour) must
      // read as zeros, not a prior frame's record from the reused scratch.
      data.fill(0, i * f, (i + 1) * f)
      const r = records[i]
      if (r) data.set(r.data, i * f)
    }
    device.queue.writeBuffer(this.storageBuffer, 0, data, 0, need)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(4, records.length)
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

export class WgpuLineRenderer extends WgpuInstancedRenderer<LineData> {
  constructor() {
    super(WGSL_LINE, FLOATS_PER_LINE)
  }
}

export class WgpuRectRenderer extends WgpuInstancedRenderer<RectData> {
  constructor() {
    super(WGSL_RECT, FLOATS_PER_RECT)
  }
}
