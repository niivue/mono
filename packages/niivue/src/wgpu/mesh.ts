import { log } from '@/logger'
import { BYTES_PER_VERTEX, packMeshVertices } from '@/mesh/vertexFormat'
import type { NVMesh, WebGPUMeshGPU } from '@/NVTypes'
import meshShaderWGSL from './mesh.wgsl?raw'

export const UNIFORM_ALIGNMENT = 256 // WebGPU minimum uniform buffer offset alignment
export const MESH_UNIFORM_SIZE = 240
export const alignedMeshSize =
  Math.ceil(MESH_UNIFORM_SIZE / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT
export const MAX_TILES = 128

export function uploadMeshGPU(
  device: GPUDevice,
  meshData: NVMesh,
  options: Record<string, unknown> = {},
): WebGPUMeshGPU & { shaderType?: string } {
  const { shaderType = 'phong' } = options as { shaderType?: string }
  const vertexData = packMeshVertices(meshData)
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    // STORAGE: crosscut2 reads vertices by index from this same buffer.
    usage:
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  })
  new Uint8Array(vertexBuffer.getMappedRange()).set(new Uint8Array(vertexData))
  vertexBuffer.unmap()
  const indexBuffer = device.createBuffer({
    size: meshData.indices.byteLength,
    // VERTEX: crosscut2 steps through it per instance, one triangle each.
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  })
  new Uint32Array(indexBuffer.getMappedRange()).set(meshData.indices)
  indexBuffer.unmap()
  // Create per-mesh uniform buffer (144 bytes to match meshParams)
  const uniformBuffer = device.createBuffer({
    size: alignedMeshSize * MAX_TILES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  return {
    vertexBuffer,
    indexBuffer,
    uniformBuffer,
    indexCount: meshData.indices.length,
    bindGroup: null,
    alignedMeshSize: alignedMeshSize,
    shaderType,
  }
}

// Per-mesh staging buffer for live vertex updates, so animating a mesh does
// not allocate a fresh interleaved buffer every frame. Safe to reuse: the
// upload copies the data before returning.
const _staging = new WeakMap<WebGPUMeshGPU, ArrayBuffer>()

function stagingFor(gpu: WebGPUMeshGPU, meshData: NVMesh): ArrayBuffer {
  const packed = packMeshVertices(meshData, _staging.get(gpu))
  _staging.set(gpu, packed)
  return packed
}

/**
 * Rewrite an existing mesh's vertex buffer in place from `meshData`. Used for
 * live vertex updates, which would otherwise rebuild every mesh's GPU
 * resources. Returns false (nothing written) when the vertex count no longer
 * matches the buffer, so the caller can fall back to a full rebuild.
 */
export function writeMeshVertices(
  device: GPUDevice,
  meshData: NVMesh,
  gpu: WebGPUMeshGPU,
): boolean {
  if (!gpu.vertexBuffer) return false
  const bytes = (meshData.positions.length / 3) * BYTES_PER_VERTEX
  if (gpu.vertexBuffer.size !== bytes) return false
  device.queue.writeBuffer(gpu.vertexBuffer, 0, stagingFor(gpu, meshData))
  return true
}

export function createMeshPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  msaaCount: number,
  pipelineLayout: GPUPipelineLayout,
  entryPoint = 'fragment_phong',
  depthFormat: GPUTextureFormat = 'depth24plus',
  vertexEntryPoint = 'vertex_main',
  depthCompare: GPUCompareFunction = 'less',
  depthWriteEnabled = true,
  cullMode: GPUCullMode = 'back',
): GPURenderPipeline {
  const shaderModule = device.createShaderModule({ code: meshShaderWGSL })
  return device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: vertexEntryPoint,
      buffers: [
        {
          arrayStride: 28,
          attributes: [
            { format: 'float32x3', offset: 0, shaderLocation: 0 }, // pos
            { format: 'float32x3', offset: 12, shaderLocation: 1 }, // norm
            { format: 'unorm8x4', offset: 24, shaderLocation: 2 }, // clr
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: entryPoint,
      targets: [
        {
          format: format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      ],
    },
    depthStencil: {
      depthWriteEnabled,
      depthCompare,
      format: depthFormat,
    },
    primitive: {
      topology: 'triangle-list',
      cullMode,
    },
    multisample: { count: msaaCount },
  })
}

/**
 * crosscut2 pipeline (see `vertex_crosscut2`): instanced by triangle, the
 * index buffer stepping per instance; vertices come from the vertex buffer
 * bound as storage in group 1. No depth test, no culling, like crosscut.
 */
export function createCrosscut2Pipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  msaaCount: number,
  pipelineLayout: GPUPipelineLayout,
  depthFormat: GPUTextureFormat = 'depth24plus',
): GPURenderPipeline {
  const shaderModule = device.createShaderModule({ code: meshShaderWGSL })
  return device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vertex_crosscut2',
      buffers: [
        {
          arrayStride: 12,
          stepMode: 'instance',
          attributes: [{ format: 'uint32x3', offset: 0, shaderLocation: 0 }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragment_crosscut2',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
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
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: msaaCount },
  })
}

const _crosscut2BindGroups = new WeakMap<GPUBuffer, GPUBindGroup>()
const _tooLarge = new WeakSet<GPUBuffer>()

/** The group-1 bind group exposing a mesh's vertex buffer to crosscut2. */
export function crosscut2BindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertexBuffer: GPUBuffer,
): GPUBindGroup | null {
  let bg = _crosscut2BindGroups.get(vertexBuffer)
  if (bg) return bg
  if (vertexBuffer.size > device.limits.maxStorageBufferBindingSize) {
    if (!_tooLarge.has(vertexBuffer)) {
      _tooLarge.add(vertexBuffer)
      log.warn('crosscut2: mesh exceeds maxStorageBufferBindingSize')
    }
    return null
  }
  bg = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: vertexBuffer } }],
  })
  _crosscut2BindGroups.set(vertexBuffer, bg)
  return bg
}

export function destroyMesh(mesh: WebGPUMeshGPU): void {
  if (mesh.vertexBuffer) {
    mesh.vertexBuffer.destroy()
    mesh.vertexBuffer = null
  }
  if (mesh.indexBuffer) {
    mesh.indexBuffer.destroy()
    mesh.indexBuffer = null
  }
  if (mesh.uniformBuffer) {
    mesh.uniformBuffer.destroy()
    mesh.uniformBuffer = null
  }
  if (mesh.bindGroup) {
    mesh.bindGroup = null // WebGPU bind groups don't need explicit destroy
  }
}
