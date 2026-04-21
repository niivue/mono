import * as NVMeshUtils from '@/mesh/NVMesh'
import type { NVMesh, WebGPUMeshGPU } from '@/NVTypes'
import { BYTES_PER_VERTEX } from '@/view/NVCrosshair'
import { buildCylinderMeshData, buildSphereMeshData } from '@/view/NVMeshView'
import meshShaderWGSL from './mesh.wgsl?raw'

export const UNIFORM_ALIGNMENT = 256 // WebGPU minimum uniform buffer offset alignment
export const MESH_UNIFORM_SIZE = 176
export const alignedMeshSize =
  Math.ceil(MESH_UNIFORM_SIZE / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT
export const MAX_TILES = 128

export function loadSphereMesh(
  device: GPUDevice,
  origin: number[] = [1, 1, 1],
  radius = 1,
  color: number[] = [1, 1, 1, 1],
  subdivisions = 2,
): NVMesh {
  return createMeshBuffers(
    device,
    buildSphereMeshData(origin, radius, color, subdivisions),
  )
}

export function loadCylinderMesh(
  device: GPUDevice,
  start: number[],
  dest: number[],
  radius: number,
  color: number[] = [1, 1, 1, 1],
  sides = 20,
  endcaps = true,
): NVMesh {
  return createMeshBuffers(
    device,
    buildCylinderMeshData(start, dest, radius, color, sides, endcaps),
  )
}

export function createMeshBuffers(
  _device: GPUDevice,
  meshData: Omit<NVMesh, 'layers' | 'perVertexColors'> &
    Partial<Pick<NVMesh, 'layers' | 'perVertexColors'>>,
  options: Record<string, unknown> = {},
): NVMesh {
  const { shaderType = 'phong' } = options as { shaderType?: string }
  const mesh = meshData as NVMesh
  mesh.opacity ??= 1
  mesh.shaderType = shaderType
  mesh.layers ??= []
  mesh.perVertexColors ??= null
  // Add any additional options to meshData
  Object.assign(mesh, options)
  return mesh
}

export function uploadMeshGPU(
  device: GPUDevice,
  meshData: NVMesh,
  options: Record<string, unknown> = {},
): WebGPUMeshGPU & { shaderType?: string } {
  const { shaderType = 'phong' } = options as { shaderType?: string }
  const normals = NVMeshUtils.generateNormals(
    meshData.positions,
    meshData.indices,
  )
  const numVerts = meshData.positions.length / 3
  const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX)
  const f32 = new Float32Array(vertexData)
  const u32 = new Uint32Array(vertexData)
  for (let i = 0; i < numVerts; i++) {
    const offset = (i * 28) / 4
    f32[offset] = meshData.positions[i * 3]
    f32[offset + 1] = meshData.positions[i * 3 + 1]
    f32[offset + 2] = meshData.positions[i * 3 + 2]
    f32[offset + 3] = normals[i * 3]
    f32[offset + 4] = normals[i * 3 + 1]
    f32[offset + 5] = normals[i * 3 + 2]
    u32[offset + 6] =
      meshData.colors instanceof Uint32Array
        ? meshData.colors[i]
        : meshData.colors
  }
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX,
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
