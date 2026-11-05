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
