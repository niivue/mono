// UIKit's own WebGPU MSDF text renderer. Mirrors the WebGL2 one: draws
// pre-transformed screen-pixel triangle vertices with the atlas bound, appending
// to the open render pass. Pipeline built to match the pass's attachment formats;
// atlas uploaded once via copyExternalImageToTexture.

import { FLOATS_PER_VERTEX } from '../text/layout'
import { WGSL_TEXT } from './shaders'

const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4
// Dynamic uniform-buffer offsets must be a multiple of
// minUniformBufferOffsetAlignment; 256 is its maximum guaranteed value, so one
// 256-byte slot per text run is always valid.
const UNIFORM_STRIDE = 256

/** One already-laid-out glyph run to draw: its vertices, vertex count and AA range. */
export type TextRun = {
  vertices: Float32Array
  count: number
  screenPxRange: number
}

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
  private uniformCapacity = 0
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
    this.sampler ??= device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          // One uniform slot per text run, addressed by a dynamic offset, so
          // multiple runs drawn into the same deferred pass each read their own
          // (width, height, screenPxRange) instead of collapsing to the last.
          buffer: { type: 'uniform', hasDynamicOffset: true },
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
      primitive: { topology: 'triangle-list' },
    })
    // Bind group depends on the texture; force a rebuild.
    this.bindGroup = null
  }

  private ensureTexture(device: GPUDevice, image: ImageBitmap): void {
    if (this.texture && this.textureImage === image) return
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
    this.bindGroup = null // texture changed -> rebuild bind group
  }

  private ensureUniformBuffer(device: GPUDevice, bytes: number): void {
    if (this.uniformBuffer && this.uniformCapacity >= bytes) return
    this.uniformCapacity = Math.max(
      bytes,
      this.uniformCapacity * 2,
      UNIFORM_STRIDE,
    )
    this.uniformBuffer?.destroy()
    this.uniformBuffer = device.createBuffer({
      size: this.uniformCapacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = null // uniform buffer changed -> rebuild bind group
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

  private ensureBindGroup(device: GPUDevice): void {
    if (this.bindGroup) return
    if (
      !this.bindLayout ||
      !this.uniformBuffer ||
      !this.texture ||
      !this.sampler
    )
      return
    this.bindGroup = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        // One 16-byte uniform slot, selected per draw via a dynamic offset.
        { binding: 0, resource: { buffer: this.uniformBuffer, size: 16 } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    })
  }

  /**
   * Draw all already-laid-out glyph runs into the open pass. Every run's
   * vertices are packed into one vertex buffer and its (width, height,
   * screenPxRange) uniform into its own 256-byte slot, so each draw reads its
   * own data — writing every run into a single shared buffer would collapse to
   * the last run before the deferred pass executes.
   */
  drawAll(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat: GPUTextureFormat | undefined,
    image: ImageBitmap,
    runs: readonly TextRun[],
    width: number,
    height: number,
  ): void {
    const drawn = runs.filter((r) => r.count > 0)
    if (drawn.length === 0) return
    this.ensurePipeline(device, colorFormat, sampleCount, depthFormat)
    this.ensureUniformBuffer(device, drawn.length * UNIFORM_STRIDE)
    this.ensureTexture(device, image)
    let totalBytes = 0
    for (const r of drawn) totalBytes += r.vertices.byteLength
    this.ensureVertexBuffer(device, totalBytes)
    this.ensureBindGroup(device)
    if (
      !this.pipeline ||
      !this.bindGroup ||
      !this.vertexBuffer ||
      !this.uniformBuffer
    )
      return

    // Pack uniforms (one 256-byte slot each) and vertices (contiguous).
    const uniforms = new Float32Array(drawn.length * (UNIFORM_STRIDE / 4))
    const vertexOffsets: number[] = []
    let vByte = 0
    for (let i = 0; i < drawn.length; i++) {
      const base = i * (UNIFORM_STRIDE / 4)
      uniforms[base] = width
      uniforms[base + 1] = height
      uniforms[base + 2] = drawn[i].screenPxRange
      uniforms[base + 3] = 0
      vertexOffsets.push(vByte)
      device.queue.writeBuffer(
        this.vertexBuffer,
        vByte,
        drawn[i].vertices as Float32Array<ArrayBuffer>,
      )
      vByte += drawn[i].vertices.byteLength
    }
    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms)

    pass.setPipeline(this.pipeline)
    for (let i = 0; i < drawn.length; i++) {
      pass.setBindGroup(0, this.bindGroup, [i * UNIFORM_STRIDE])
      pass.setVertexBuffer(
        0,
        this.vertexBuffer,
        vertexOffsets[i],
        drawn[i].vertices.byteLength,
      )
      pass.draw(drawn[i].count)
    }
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
    this.uniformCapacity = 0
    this.key = ''
  }
}
