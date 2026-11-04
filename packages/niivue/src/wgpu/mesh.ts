import { log } from '@/logger'
import {
  CLUSTER_SIZE,
  clustersCrossingPlanes,
  meshClusters,
  PLANE_SHIFT,
  sortedIndices,
  type TriangleClusters,
} from '@/mesh/triangleClusters'
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
 * crosscut2 pipeline (see `vertex_crosscut2`): no vertex buffers; vertices,
 * cluster-ordered triangle indices and the tile's cluster list come from
 * group 1. No depth test, no culling, like crosscut.
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
      constants: { clusterSize: CLUSTER_SIZE, planeShift: PLANE_SHIFT },
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

type Crosscut2Gpu = {
  clusters: TriangleClusters
  /** Triangle indices in cluster order. A copy: the mesh's own index buffer
   *  keeps the file's order, which translucent 3D blending depends on. */
  triBuffer: GPUBuffer
  /** One region per tile slot, so per-tile writes within a pass do not collide. */
  listBuffer: GPUBuffer
  regionBytes: number
  regions: number
  bindGroup: GPUBindGroup
}
const _crosscut2 = new WeakMap<WebGPUMeshGPU, Crosscut2Gpu>()
const _tooLarge = new WeakSet<WebGPUMeshGPU>()
const _tooManyTiles = new WeakSet<WebGPUMeshGPU>()

// Build or resize `gpu`'s crosscut2 resources. Within a frame the clusters
// and tile count are fixed, so only a mesh's first draw of a frame can
// replace the buffers, before any draw of this pass references them.
function crosscut2Gpu(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  meshData: NVMesh,
  gpu: WebGPUMeshGPU,
  tileCount: number,
): Crosscut2Gpu | null {
  const vertexBuffer = gpu.vertexBuffer
  if (!vertexBuffer || _tooLarge.has(gpu)) return null
  const clusters = meshClusters(meshData)
  if (clusters.clusterCount === 0) return null
  // The bound index copy is padded to whole clusters (12 B per triangle).
  const maxBind = device.limits.maxStorageBufferBindingSize
  const triBytes = clusters.clusterCount * CLUSTER_SIZE * 12
  if (vertexBuffer.size > maxBind || triBytes > maxBind) {
    _tooLarge.add(gpu)
    log.warn('crosscut2: mesh exceeds maxStorageBufferBindingSize')
    return null
  }
  let cc = _crosscut2.get(gpu)
  if (cc && cc.clusters === clusters && cc.regions >= tileCount) return cc
  const align = device.limits.minStorageBufferOffsetAlignment
  const regionBytes = Math.ceil(clusters.entries.byteLength / align) * align
  // At least four regions (A+C+S+R), so common layouts never regrow.
  const regions = Math.max(tileCount, 4)
  // An oversized buffer is invalid and fails the whole frame's submit. Not
  // added to _tooLarge: fewer tiles later can still draw.
  if (regionBytes * regions > device.limits.maxBufferSize) {
    if (!_tooManyTiles.has(gpu)) {
      _tooManyTiles.add(gpu)
      log.warn('crosscut2: mesh is too large for this many tiles')
    }
    return null
  }
  let triBuffer = cc?.triBuffer
  if (!triBuffer || cc?.clusters !== clusters) {
    triBuffer?.destroy()
    const sorted = sortedIndices(meshData.indices, clusters.order)
    triBuffer = device.createBuffer({
      size: sorted.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    })
    new Uint32Array(triBuffer.getMappedRange()).set(sorted)
    triBuffer.unmap()
  }
  cc?.listBuffer.destroy()
  const listBuffer = device.createBuffer({
    size: regionBytes * regions,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: vertexBuffer } },
      { binding: 1, resource: { buffer: triBuffer } },
      { binding: 2, resource: { buffer: listBuffer, size: regionBytes } },
    ],
  })
  cc = { clusters, triBuffer, listBuffer, regionBytes, regions, bindGroup }
  _crosscut2.set(gpu, cc)
  return cc
}

/**
 * Record one tile's crosscut2 draw: upload the clusters its planes cross into
 * the tile's region and draw one instance per triangle of those clusters,
 * six vertices each. The caller has set the pipeline and group 0.
 */
export function drawCrosscut2(
  device: GPUDevice,
  pass: GPURenderPassEncoder,
  layout: GPUBindGroupLayout,
  meshData: NVMesh,
  gpu: WebGPUMeshGPU,
  ccPlanes: Float32Array,
  tileSlot: number,
  tileCount: number,
): void {
  if (ccPlanes[14] <= 0) return // zero width: draw nothing, like crosscut
  const cc = crosscut2Gpu(device, layout, meshData, gpu, tileCount)
  if (!cc) return
  const entries = clustersCrossingPlanes(cc.clusters, ccPlanes)
  if (entries.length === 0) return
  const offset = tileSlot * cc.regionBytes
  device.queue.writeBuffer(cc.listBuffer, offset, entries)
  pass.setBindGroup(1, cc.bindGroup, [offset])
  pass.draw(6, entries.length * CLUSTER_SIZE)
}

function destroyCrosscut2(gpu: WebGPUMeshGPU): void {
  const cc = _crosscut2.get(gpu)
  cc?.triBuffer.destroy()
  cc?.listBuffer.destroy()
  _crosscut2.delete(gpu)
}

export function destroyMesh(mesh: WebGPUMeshGPU): void {
  destroyCrosscut2(mesh)
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
