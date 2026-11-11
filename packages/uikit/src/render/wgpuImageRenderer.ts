// UIKit's WebGPU image renderer: one textured quad at a canvas-pixel box,
// appended to the open pass with a pipeline matched to its attachments. The
// texture is re-copied only when the caller bumps `version` (or hands a new
// source), and recreated only when the source size changes.

import type { UIKitBox } from '../rect'
import type { UIKitImageSource } from './glImageRenderer'
import { WGSL_IMAGE } from './shaders'

export class WgpuImageRenderer {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private uniformBuffer: GPUBuffer | null = null
  private sampler: GPUSampler | null = null
  private texture: GPUTexture | null = null
  private bindGroup: GPUBindGroup | null = null
  private source: UIKitImageSource | null = null
  private version = -1
  private key = ''
  private readonly uniforms = new Float32Array(8)

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
    this.uniformBuffer ??= device.createBuffer({
      size: this.uniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    const module = device.createShaderModule({ code: WGSL_IMAGE })
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
      // Only declare depth-stencil when the target pass has a depth attachment
      // (the main NiiVue view does; the slide viewer does not).
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

  private ensureTexture(
    device: GPUDevice,
    source: UIKitImageSource,
    version: number,
  ): void {
    if (this.texture && this.source === source && this.version === version)
      return
    const { width, height } = source
    if (
      !this.texture ||
      this.texture.width !== width ||
      this.texture.height !== height
    ) {
      this.texture?.destroy()
      this.texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.bindGroup = null
    }
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: this.texture },
      [width, height],
    )
    this.source = source
    this.version = version
  }

  /** Append `source` stretched over `box` (canvas px) to the open pass. */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat | undefined,
    source: UIKitImageSource,
    version: number,
    box: UIKitBox,
    width: number,
    height: number,
  ): void {
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureTexture(device, source, version)
    if (
      !this.pipeline ||
      !this.bindLayout ||
      !this.uniformBuffer ||
      !this.texture ||
      !this.sampler
    )
      return
    this.bindGroup ??= device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    })
    const u = this.uniforms
    u[0] = width
    u[1] = height
    u[4] = box.x
    u[5] = box.y
    u[6] = box.width
    u[7] = box.height
    device.queue.writeBuffer(this.uniformBuffer, 0, u)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(4)
  }

  destroy(): void {
    this.uniformBuffer?.destroy()
    this.texture?.destroy()
    this.device = null
    this.pipeline = null
    this.bindLayout = null
    this.uniformBuffer = null
    this.sampler = null
    this.texture = null
    this.bindGroup = null
    this.source = null
    this.version = -1
    this.key = ''
  }
}
