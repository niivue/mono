// UIKit's own WebGPU MSDF text renderer. Mirrors the WebGL2 one: draws
// pre-transformed screen-pixel triangle vertices with the atlas bound, appending
// to the open render pass. Pipeline built to match the pass's attachment formats;
// atlas uploaded once via copyExternalImageToTexture.

import { FLOATS_PER_VERTEX } from '../text/layout'
import { WGSL_TEXT } from './shaders'

const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4

export class WgpuTextRenderer {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private uniformBuffer: GPUBuffer | null = null
  private vertexBuffer: GPUBuffer | null = null
  private sampler: GPUSampler | null = null
  private texture: GPUTexture | null = null
  private textureImage: ImageBitmap | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacityBytes = 0
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
    this.uniformBuffer ??= device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.sampler ??= device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    const module = device.createShaderModule({ code: WGSL_TEXT })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: sampleCount },
      vertex: {
        module,
        entryPoint: 'vertex_main',
        buffers: [
          {
            arrayStride: BYTES_PER_VERTEX,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
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
      primitive: { topology: 'triangle-list' },
    })
    // Bind group depends on the texture; force a rebuild.
    this.bindGroup = null
  }

  private ensureTexture(device: GPUDevice, image: ImageBitmap): void {
    if (this.texture && this.textureImage === image && this.bindGroup) return
    this.texture?.destroy()
    this.texture = device.createTexture({
      size: [image.width, image.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this.texture },
      [image.width, image.height],
    )
    this.textureImage = image
    if (this.bindLayout && this.uniformBuffer && this.sampler) {
      this.bindGroup = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
    }
  }

  private ensureVertexBuffer(device: GPUDevice, bytes: number): void {
    if (this.vertexBuffer && this.capacityBytes >= bytes) return
    this.capacityBytes = Math.max(bytes, this.capacityBytes * 2, 4096)
    this.vertexBuffer?.destroy()
    this.vertexBuffer = device.createBuffer({
      size: this.capacityBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
  }

  /** Append one already-laid-out glyph run to the open pass. */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat,
    image: ImageBitmap,
    vertices: Float32Array,
    count: number,
    screenPxRange: number,
    width: number,
    height: number,
  ): void {
    if (count === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureTexture(device, image)
    this.ensureVertexBuffer(device, vertices.byteLength)
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer) return
    device.queue.writeBuffer(
      this.uniformBuffer as GPUBuffer,
      0,
      new Float32Array([width, height, screenPxRange, 0]),
    )
    device.queue.writeBuffer(
      this.vertexBuffer,
      0,
      vertices as Float32Array<ArrayBuffer>,
    )
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.draw(count)
  }

  destroy(): void {
    this.uniformBuffer?.destroy()
    this.vertexBuffer?.destroy()
    this.texture?.destroy()
    this.device = null
    this.pipeline = null
    this.bindLayout = null
    this.uniformBuffer = null
    this.vertexBuffer = null
    this.sampler = null
    this.texture = null
    this.textureImage = null
    this.bindGroup = null
    this.capacityBytes = 0
    this.key = ''
  }
}
