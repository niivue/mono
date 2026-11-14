// UIKit's WebGPU magnifier lens: takes the host's copy of the frame drawn so
// far (`captureScene`, which moves the frame onto a fresh pass) and draws it
// enlarged in a circle. Nothing is drawn on a host without `captureScene`.

import type { UIKitBackendHandle } from '@niivue/niivue'
import type { MagnifierLayout } from '../magnifier'
import { WGSL_LENS } from './shaders'

type WebGPUHandle = Extract<UIKitBackendHandle, { backend: 'webgpu' }>

export class WgpuLensRenderer {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindLayout: GPUBindGroupLayout | null = null
  private uniformBuffer: GPUBuffer | null = null
  private sampler: GPUSampler | null = null
  private bindGroup: GPUBindGroup | null = null
  private boundTexture: GPUTexture | null = null
  private key = ''
  private readonly uniforms = new Float32Array(16)

  private ensurePipeline(handle: WebGPUHandle): void {
    const { device, colorFormat, sampleCount, depthFormat } = handle
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
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    const module = device.createShaderModule({ code: WGSL_LENS })
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

  /** Append the lens to the frame; `width` x `height` is the drawable size. */
  draw(
    handle: WebGPUHandle,
    layout: MagnifierLayout,
    fill: readonly number[],
    width: number,
    height: number,
  ): void {
    const scene = handle.captureScene?.()
    if (!scene) return
    // After the capture: the handle now describes the continuation pass.
    this.ensurePipeline(handle)
    const { device } = handle
    if (
      !this.pipeline ||
      !this.bindLayout ||
      !this.uniformBuffer ||
      !this.sampler
    )
      return
    if (!this.bindGroup || this.boundTexture !== scene) {
      this.bindGroup = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: scene.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.boundTexture = scene
    }
    const u = this.uniforms
    const { lens } = layout
    u.set([width, height, scene.width, scene.height], 0)
    u.set([lens.x, lens.y, lens.width, lens.height], 4)
    u.set([layout.centerX, layout.centerY, layout.radius, layout.zoom], 8)
    u.set(fill.slice(0, 4), 12)
    device.queue.writeBuffer(this.uniformBuffer, 0, u)
    handle.pass.setPipeline(this.pipeline)
    handle.pass.setBindGroup(0, this.bindGroup)
    handle.pass.draw(4)
  }

  destroy(): void {
    this.uniformBuffer?.destroy()
    this.device = null
    this.pipeline = null
    this.bindLayout = null
    this.uniformBuffer = null
    this.sampler = null
    this.bindGroup = null
    this.boundTexture = null
  }
}
