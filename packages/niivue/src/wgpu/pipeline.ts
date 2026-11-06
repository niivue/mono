import type { NVSlideColorLut } from '@/slide/NVSlide'

// Shared WebGPU renderer setup helpers.

/** Straight-alpha "over" blend. */
const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
}

/** Depth state for overlays drawn over everything without writing depth. */
export function overlayDepth(
  format: GPUTextureFormat = 'depth24plus',
): GPUDepthStencilState {
  return { depthWriteEnabled: false, depthCompare: 'always', format }
}

export function uniformBuffer(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
}

export function linearSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
}

export function uniformEntry(
  visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry {
  return { binding: 0, visibility, buffer: { type: 'uniform' } }
}

/** Bindings: 0 uniform, 1 2D texture, 2 sampler. */
export function texturedLayout(
  device: GPUDevice,
  uniformVisibility: GPUShaderStageFlags,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      uniformEntry(uniformVisibility),
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
}

/** Bindings: 0 uniform, 1 vertex read-only storage. */
export function uniformStorageEntries(
  uniformVisibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry[] {
  return [
    uniformEntry(uniformVisibility),
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: 'read-only-storage' },
    },
  ]
}

/**
 * Alpha-blended pipeline with `vertex_main` / `fragment_main` entry points.
 * Returns the descriptor so callers can derive depth variants from it.
 */
export function alphaPipelineDesc(
  device: GPUDevice,
  o: {
    module: GPUShaderModule
    bindGroupLayouts: GPUBindGroupLayout[]
    format: GPUTextureFormat
    msaaCount?: number
    depthStencil?: GPUDepthStencilState
    primitive?: GPUPrimitiveState
    buffers?: GPUVertexBufferLayout[]
  },
): GPURenderPipelineDescriptor {
  return {
    layout: device.createPipelineLayout({
      bindGroupLayouts: o.bindGroupLayouts,
    }),
    multisample: { count: o.msaaCount ?? 1 },
    vertex: { module: o.module, entryPoint: 'vertex_main', buffers: o.buffers },
    fragment: {
      module: o.module,
      entryPoint: 'fragment_main',
      targets: [{ format: o.format, blend: ALPHA_BLEND }],
    },
    depthStencil: o.depthStencil,
    primitive: o.primitive ?? { topology: 'triangle-strip' },
  }
}

/** Bindings: 0 3D texture, 1 sampler (a slide colour table, see slide/colorLutShader.ts). */
export function colorLutLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: '3d' },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
}

/** One 3D texture and bind group per slide colour table, uploaded on first use. */
export class ColorLutTexturesGPU {
  private readonly _entries = new Map<
    NVSlideColorLut,
    { texture: GPUTexture; group: GPUBindGroup }
  >()

  constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly sampler: GPUSampler,
  ) {}

  group(lut: NVSlideColorLut): GPUBindGroup {
    const existing = this._entries.get(lut)
    if (existing) return existing.group
    const n = lut.size
    const texture = this.device.createTexture({
      size: [n, n, n],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture(
      { texture },
      lut.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: n * 4, rowsPerImage: n },
      [n, n, n],
    )
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: texture.createView({ dimension: '3d' }) },
        { binding: 1, resource: this.sampler },
      ],
    })
    this._entries.set(lut, { texture, group })
    return group
  }

  clear(): void {
    for (const { texture } of this._entries.values()) texture.destroy()
    this._entries.clear()
  }
}
