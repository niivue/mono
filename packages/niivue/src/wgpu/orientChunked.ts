// Per-chunk upload + orient + gradient pipeline for tiled volumes.
//
// For each chunk in a ChunkPlan, extracts the chunk's source voxel range
// from the CPU image buffer, uploads it as a per-chunk source 3D texture,
// runs the orient compute pass with identity matrix (output dims == source
// dims), then runs the gradient (sobel + blur) compute pass on the per-chunk
// RGBA output. Returns one {volumeTexture, volumeGradientTexture} per chunk.
//
// Scope:
//   - Scalar datatypes only (uint8/uint16/uint32, int16/int32, float32). RGB
//     (128) and RGBA (2304) sources throw — they need a chunked variant of
//     prepareRGBAData and are deferred.
//   - RAS-aligned (identity permutation) sources use a fast strided row copy.
//     Non-identity sources (axis swaps/flips) are reoriented to RAS order
//     voxel-by-voxel during the per-chunk CPU extraction, so the orient pass
//     still runs with an identity matrix on an already-RAS chunk texture.
//
// The orient uniform buffer, colormap textures, and sampler are shared across
// chunks (one upload, N bind groups). Per-chunk source textures are destroyed
// after the orient pass; per-chunk RGBA + gradient textures are returned to
// the caller and live for the chunk's lifetime in the renderer cache.

import * as NVCmaps from '@/cmap/NVCmaps'
import type { NVImage } from '@/NVTypes'
import { buildOrientUniforms } from '@/view/NVOrient'
import type { ChunkPlan, Vec3i, VolumeChunkDesc } from '@/volume/chunking'
import {
  extractChunkBytes,
  extractChunkBytesReoriented,
  isIdentityPermutation,
} from '@/volume/orientChunked'
import { ensureOrientPipeline } from './orient'
import * as wgpu from './wgpu'

export interface VolumeChunkGPU {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: GPUTexture
  /** RGBA8 gradient texture for this chunk; sized desc.texDims. */
  volumeGradientTexture: GPUTexture
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

/** Identity row-major 4x4 — orient.wgsl reads mtxRow0..3 as vec4 rows. */
const IDENTITY_MAT4: Float32Array = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
])

function getTextureFormat(datatypeCode: number): {
  format: GPUTextureFormat
  pipelineType: string
  bytesPerVoxel: number
} {
  switch (datatypeCode) {
    case 2:
      return { format: 'r8uint', pipelineType: 'uint', bytesPerVoxel: 1 }
    case 4:
      return { format: 'r16sint', pipelineType: 'sint', bytesPerVoxel: 2 }
    case 8:
      return { format: 'r32sint', pipelineType: 'sint', bytesPerVoxel: 4 }
    case 16:
    case 32:
      return { format: 'r32float', pipelineType: 'float', bytesPerVoxel: 4 }
    case 512:
      return { format: 'r16uint', pipelineType: 'uint', bytesPerVoxel: 2 }
    case 768:
      return { format: 'r32uint', pipelineType: 'uint', bytesPerVoxel: 4 }
    default:
      throw new Error(
        `orientChunked: unsupported NIfTI datatype ${datatypeCode}`,
      )
  }
}

function writeIdentityOrientUniforms(
  device: GPUDevice,
  uniformBuffer: GPUBuffer,
  nvimage: NVImage,
): void {
  const ab = new ArrayBuffer(7 * 16)
  const dv = new DataView(ab)
  for (let i = 0; i < 16; i++) dv.setFloat32(i * 4, IDENTITY_MAT4[i], true)
  const u = buildOrientUniforms(nvimage, 1)
  dv.setFloat32(64, u.slope, true)
  dv.setFloat32(68, u.intercept, true)
  dv.setFloat32(72, u.calMin, true)
  dv.setFloat32(76, u.calMax, true)
  dv.setFloat32(80, u.mnNeg, true)
  dv.setFloat32(84, u.mxNeg, true)
  dv.setFloat32(88, u.isAlphaThreshold, true)
  dv.setFloat32(92, u.isColorbarFromZero, true)
  dv.setFloat32(96, u.overlayOpacity, true)
  dv.setFloat32(100, u.isLabel, true)
  dv.setFloat32(104, u.labelMin, true)
  dv.setFloat32(108, u.labelWidth, true)
  device.queue.writeBuffer(uniformBuffer, 0, ab)
}

async function createColormapResources(
  device: GPUDevice,
  nvimage: NVImage,
): Promise<{
  colormapTexture: GPUTexture
  negativeColormapTexture: GPUTexture
  hasNegativeColormap: boolean
  sampler: GPUSampler
}> {
  const u = buildOrientUniforms(nvimage, 1)
  if (u.isLabel > 0) {
    const labelLut = nvimage.colormapLabel?.lut
    if (!labelLut) {
      throw new Error('orientChunked: label colormap LUT is undefined')
    }
    const nLabels = labelLut.length / 4
    const labelTex = device.createTexture({
      size: [nLabels, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: labelTex },
      Uint8Array.from(labelLut),
      { bytesPerRow: nLabels * 4, rowsPerImage: 1 },
      [nLabels, 1],
    )
    return {
      colormapTexture: labelTex,
      negativeColormapTexture: labelTex,
      hasNegativeColormap: false,
      sampler: device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
      }),
    }
  }
  const colormapTexture = await wgpu.lutBytes2texture(
    device,
    NVCmaps.lutrgba8(nvimage.colormap),
  )
  const hasNegativeColormap = !!(
    nvimage.colormapNegative && nvimage.colormapNegative.length > 0
  )
  const negativeColormapTexture = hasNegativeColormap
    ? await wgpu.lutBytes2texture(
        device,
        NVCmaps.lutrgba8(nvimage.colormapNegative),
      )
    : colormapTexture
  return {
    colormapTexture,
    negativeColormapTexture,
    hasNegativeColormap,
    sampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    }),
  }
}

/**
 * On-demand chunk uploader for a chunked volume. The renderer keeps one of
 * these per chunked volume and calls `uploadChunk` to stream chunks in across
 * frames instead of uploading the whole volume at load. `dispose` releases the
 * shared orient resources once the volume leaves the texture cache.
 */
export interface ChunkUploaderGPU {
  /** Upload, orient, and gradient the chunk at `index` in the plan. */
  uploadChunk(index: number): Promise<VolumeChunkGPU>
  /** Release the shared uniform/colormap GPU resources. */
  dispose(): void
}

/**
 * Build an on-demand chunk uploader for a chunked volume.
 *
 * The shared orient resources (uniform buffer, colormap textures, sampler) are
 * created once here and reused by every `uploadChunk` call. Each `uploadChunk`
 * extracts one chunk's source voxels, uploads + orients + gradients it, and
 * returns its RGBA + gradient textures; the transient per-chunk source texture
 * is destroyed before returning. The renderer pumps these calls a few per
 * frame so a tiled volume streams in rather than stalling the main thread.
 */
export async function createChunkUploaderGPU(
  device: GPUDevice,
  nvimage: NVImage,
  plan: ChunkPlan,
): Promise<ChunkUploaderGPU> {
  if (!nvimage.dimsRAS) {
    throw new Error('orientChunked: missing dimsRAS')
  }
  if (!nvimage.img) {
    throw new Error('orientChunked: missing image data')
  }
  const dt = nvimage.hdr.datatypeCode
  if (dt === 128 || dt === 2304) {
    throw new Error(
      `orientChunked: RGB/RGBA datatypes (${dt}) are not yet supported for chunked volumes`,
    )
  }
  const volumeDims: Vec3i = [
    nvimage.dimsRAS[1],
    nvimage.dimsRAS[2],
    nvimage.dimsRAS[3],
  ]
  if (
    volumeDims[0] !== plan.volumeDims[0] ||
    volumeDims[1] !== plan.volumeDims[1] ||
    volumeDims[2] !== plan.volumeDims[2]
  ) {
    throw new Error(
      `orientChunked: plan.volumeDims [${plan.volumeDims}] does not match ` +
        `nvimage.dimsRAS [${volumeDims}]`,
    )
  }

  const { format, pipelineType, bytesPerVoxel } = getTextureFormat(dt)
  const cached = ensureOrientPipeline(device, pipelineType)

  // Shared resources: one uniform buffer + colormap + sampler reused per chunk.
  const uniformBuffer = device.createBuffer({
    size: 7 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  writeIdentityOrientUniforms(device, uniformBuffer, nvimage)
  const {
    colormapTexture,
    negativeColormapTexture,
    hasNegativeColormap,
    sampler,
  } = await createColormapResources(device, nvimage)

  const frame4D = nvimage.frame4D ?? 0
  const frameByteOffset = frame4D * nvimage.nVox3D * bytesPerVoxel
  const srcBytes = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset + frameByteOffset,
    nvimage.nVox3D * bytesPerVoxel,
  )

  const identity = isIdentityPermutation(nvimage)
  const img2RASstart = nvimage.img2RASstart
  const img2RASstep = nvimage.img2RASstep
  if (!identity && (!img2RASstep || !img2RASstart)) {
    throw new Error('orientChunked: source is non-RAS but missing RAS mapping')
  }

  async function uploadChunk(index: number): Promise<VolumeChunkGPU> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunked: chunk index ${index} out of range`)
    }
    const chunkBytes =
      identity || !img2RASstart || !img2RASstep
        ? extractChunkBytes(
            srcBytes,
            volumeDims,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
          )
        : extractChunkBytesReoriented(
            srcBytes,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
            img2RASstart,
            img2RASstep,
          )
    const sourceTexture = device.createTexture({
      size: desc.texDims,
      format,
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: sourceTexture },
      chunkBytes as Uint8Array<ArrayBuffer>,
      {
        bytesPerRow: desc.texDims[0] * bytesPerVoxel,
        rowsPerImage: desc.texDims[1],
      },
      desc.texDims,
    )
    const rgbaTexture = device.createTexture({
      size: desc.texDims,
      format: 'rgba8unorm',
      dimension: '3d',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    const bindGroup = device.createBindGroup({
      layout: cached.layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sourceTexture.createView() },
        { binding: 2, resource: colormapTexture.createView() },
        { binding: 3, resource: rgbaTexture.createView() },
        { binding: 4, resource: sampler },
        { binding: 5, resource: negativeColormapTexture.createView() },
      ],
    })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(cached.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(
      Math.ceil(desc.texDims[0] / 8),
      Math.ceil(desc.texDims[1] / 8),
      Math.ceil(desc.texDims[2] / 4),
    )
    pass.end()
    device.queue.submit([encoder.finish()])
    await device.queue.onSubmittedWorkDone()
    sourceTexture.destroy()

    const gradientTexture = await wgpu.volume2TextureGradientRGBA(
      device,
      rgbaTexture,
    )
    return {
      volumeTexture: rgbaTexture,
      volumeGradientTexture: gradientTexture,
      desc,
    }
  }

  function dispose(): void {
    uniformBuffer.destroy()
    colormapTexture.destroy()
    if (hasNegativeColormap) negativeColormapTexture.destroy()
  }

  return { uploadChunk, dispose }
}

/** Release all per-chunk GPU textures from a previous build. */
export function destroyVolumeChunksGPU(chunks: VolumeChunkGPU[] | null): void {
  if (!chunks) return
  for (const c of chunks) {
    c.volumeTexture.destroy()
    c.volumeGradientTexture.destroy()
  }
}
