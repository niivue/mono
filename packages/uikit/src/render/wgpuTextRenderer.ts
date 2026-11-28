// The WebGPU MSDF text renderer, for uikit's overlays and NiiVue core's labels
// alike: one instanced quad per glyph record (text/layout.ts FLOATS_PER_GLYPH),
// read from a storage buffer that grows as needed, appended to the open render
// pass. The pipeline matches the pass's attachment formats; the atlas is
// re-uploaded when its source changes. One draw per renderer per pass: a second
// draw would overwrite the first's glyphs before the pass runs.

import { FLOATS_PER_GLYPH } from '../text/layout'
import type { UIKitAtlasSource } from './glTextRenderer'
import { WGSL_TEXT } from './shaders'
import { overlayPipeline } from './wgpuUtil'

const BYTES_PER_GLYPH = FLOATS_PER_GLYPH * 4

export class WgpuTextRenderer {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private paramsBuffer: GPUBuffer | null = null
  private glyphBuffer: GPUBuffer | null = null
  private sampler: GPUSampler | null = null
  private texture: GPUTexture | null = null
  private atlas: UIKitAtlasSource | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacity = 0
  private key = ''
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
    this.sampler ??= device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.paramsBuffer ??= device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const stages = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: stages, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: stages,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this.pipeline = overlayPipeline(
      device,
      device.createShaderModule({ code: WGSL_TEXT }),
      this.bindLayout,
      colorFormat,
      sampleCount,
      depthFormat,
    )
    this.bindGroup = null
  }

  private ensureTexture(device: GPUDevice, atlas: UIKitAtlasSource): void {
    if (this.texture && this.atlas === atlas) return
    this.texture?.destroy()
    this.texture = device.createTexture({
      size: [atlas.width, atlas.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
      { source: atlas },
      { texture: this.texture },
      [atlas.width, atlas.height],
    )
    this.atlas = atlas
    this.bindGroup = null
  }

  private ensureCapacity(device: GPUDevice, count: number): void {
    if (this.glyphBuffer && this.capacity >= count) return
    this.capacity = Math.max(count, this.capacity * 2, 256)
    this.glyphBuffer?.destroy()
    this.glyphBuffer = device.createBuffer({
      size: this.capacity * BYTES_PER_GLYPH,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = null
  }

  /**
   * Append `count` glyph records from `glyphs` (screen pixels) to the open
   * pass over a `width` x `height` bounds rect, in one instanced draw.
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat | undefined,
    atlas: UIKitAtlasSource,
    glyphs: Float32Array,
    count: number,
    width: number,
    height: number,
  ): void {
    if (count === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureTexture(device, atlas)
    this.ensureCapacity(device, count)
    const bindLayout = this.bindLayout
    const paramsBuffer = this.paramsBuffer
    const glyphBuffer = this.glyphBuffer
    const texture = this.texture
    const sampler = this.sampler
    if (!bindLayout || !paramsBuffer || !glyphBuffer || !texture || !sampler)
      return
    this.bindGroup ??= device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: glyphBuffer } },
        { binding: 2, resource: texture.createView() },
        { binding: 3, resource: sampler },
      ],
    })
    this.params[0] = width
    this.params[1] = height
    device.queue.writeBuffer(paramsBuffer, 0, this.params)
    device.queue.writeBuffer(
      glyphBuffer,
      0,
      glyphs as Float32Array<ArrayBuffer>,
      0,
      count * FLOATS_PER_GLYPH,
    )
    if (!this.pipeline) return
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(4, count)
  }

  destroy(): void {
    this.paramsBuffer?.destroy()
    this.glyphBuffer?.destroy()
    this.texture?.destroy()
    this.device = null
    this.pipeline = null
    this.bindLayout = null
    this.paramsBuffer = null
    this.glyphBuffer = null
    this.sampler = null
    this.texture = null
    this.atlas = null
    this.bindGroup = null
    this.capacity = 0
    this.key = ''
  }
}
