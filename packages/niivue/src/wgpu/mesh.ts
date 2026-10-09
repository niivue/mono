import type { NVMesh, WebGPUMeshGPU } from '@/NVTypes'
import { packMeshVertices } from '@/view/NVMeshView'
import meshShaderWGSL from './mesh.wgsl?raw'

export const UNIFORM_ALIGNMENT = 256 // WebGPU minimum uniform buffer offset alignment
export const MESH_UNIFORM_SIZE = 176
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
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Uint8Array(vertexBuffer.getMappedRange()).set(new Uint8Array(vertexData))
  vertexBuffer.unmap()
  const indexBuffer = device.createBuffer({
    size: meshData.indices.byteLength,
    usage: GPUBufferUsage.INDEX,
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
  const vertexData = packMeshVertices(meshData)
  if (gpu.vertexBuffer.size !== vertexData.byteLength) return false
  device.queue.writeBuffer(gpu.vertexBuffer, 0, vertexData)
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
