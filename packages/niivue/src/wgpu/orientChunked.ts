// Per-chunk upload + orient + gradient pipeline for tiled volumes.
//
// For each chunk in a ChunkPlan, extracts the chunk's source voxel range
// from the CPU image buffer, uploads it as a per-chunk source 3D texture,
// runs the orient compute pass with identity matrix (output dims == source
// dims), then runs the gradient (sobel + blur) compute pass on the per-chunk
// RGBA output. Returns one {volumeTexture, volumeGradientTexture} per chunk.
//
// Scope:
//   - Scalar datatypes (uint8/uint16/uint32, int16/int32, float32) orient
//     through the compute pass; RGB (128) / RGBA (2304) color skips it and
//     uploads chunk bytes straight into an RGBA8 texture (see chunkRGBA).
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
  chunkRGBA,
  extractChunkBytes,
  extractChunkBytesReoriented,
  isIdentityPermutation,
  isRGBAChunkDatatype,
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
  const u = buildOrientUniforms(nvimage, 0)
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
  const u = buildOrientUniforms(nvimage, 0)
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
  /**
   * Kick off (and cache) the source-byte fetch for `index` ahead of upload, so
   * network-backed fetches for the working set run in parallel instead of
   * serially inside the pump. Bounded and a no-op for in-memory volumes.
   */
  prefetchChunk(index: number): void
  /** Release the shared uniform/colormap GPU resources. */
  dispose(): void
}

/**
 * Max outstanding prefetched (fetched-but-not-yet-uploaded) chunk byte buffers
 * per uploader. Bounds CPU memory held by parallel prefetch: at ~256^3 * bpv
 * per buffer this caps a uint16 source at roughly half a gigabyte.
 */
const MAX_PREFETCHED_CHUNKS = 16

function bytesFromChunkSource(
  data: ArrayBuffer | Uint8Array | NonNullable<NVImage['img']>,
  expectedBytes: number,
): Uint8Array {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `orientChunked: chunk source returned ${bytes.byteLength} bytes, expected ${expectedBytes}`,
    )
  }
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes)
}

// Shared orient-compute resources for scalar volumes: the source-format
// texture/pipeline, the identity orient uniforms, and the colormap textures.
// Built once per chunked volume and reused by every chunk; not built at all for
// color volumes (which upload to RGBA8 directly).
interface OrientMachinery {
  format: GPUTextureFormat
  cached: ReturnType<typeof ensureOrientPipeline>
  uniformBuffer: GPUBuffer
  colormapTexture: GPUTexture
  negativeColormapTexture: GPUTexture
  hasNegativeColormap: boolean
  sampler: GPUSampler
}

async function buildOrientMachinery(
  device: GPUDevice,
  nvimage: NVImage,
  dt: number,
): Promise<OrientMachinery> {
  const { format, pipelineType } = getTextureFormat(dt)
  const cached = ensureOrientPipeline(device, pipelineType)
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
  return {
    format,
    cached,
    uniformBuffer,
    colormapTexture,
    negativeColormapTexture,
    hasNegativeColormap,
    sampler,
  }
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
 *
 * Color (RGB/RGBA) volumes skip the orient compute entirely and upload their
 * chunk bytes straight into an RGBA8 texture.
 */
export async function createChunkUploaderGPU(
  device: GPUDevice,
  nvimage: NVImage,
  plan: ChunkPlan,
): Promise<ChunkUploaderGPU> {
  if (!nvimage.dimsRAS) {
    throw new Error('orientChunked: missing dimsRAS')
  }
  const chunkSource = nvimage.chunkSource
  if (!nvimage.img && !chunkSource) {
    throw new Error('orientChunked: missing image data')
  }
  const dt = nvimage.hdr.datatypeCode
  // RGB/RGBA color sources upload straight to RGBA8 (see chunkRGBA), bypassing
  // the orient/colormap compute pass — the chunked analogue of rgba2Texture.
  const isRGBA = isRGBAChunkDatatype(dt)
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

  // Scalar volumes orient through a compute pass (source-format texture +
  // colormap -> RGBA8). Color volumes skip all of that, so build the orient
  // machinery only when needed.
  const bytesPerVoxel = isRGBA
    ? dt === 128
      ? 3
      : 4
    : getTextureFormat(dt).bytesPerVoxel
  const orient = isRGBA ? null : await buildOrientMachinery(device, nvimage, dt)

  const frame4D = nvimage.frame4D ?? 0
  const frameByteOffset = frame4D * nvimage.nVox3D * bytesPerVoxel
  const srcBytes = nvimage.img
    ? new Uint8Array(
        nvimage.img.buffer,
        nvimage.img.byteOffset + frameByteOffset,
        nvimage.nVox3D * bytesPerVoxel,
      )
    : null

  const identity = chunkSource ? true : isIdentityPermutation(nvimage)
  const img2RASstart = nvimage.img2RASstart
  const img2RASstep = nvimage.img2RASstep
  if (!chunkSource && !identity && (!img2RASstep || !img2RASstart)) {
    throw new Error('orientChunked: source is non-RAS but missing RAS mapping')
  }

  // Cache of in-flight / ready source-byte fetches, keyed by chunk index. Only
  // populated for chunkSource (network-backed) volumes; in-memory extraction is
  // synchronous and cheap, so it is computed on demand without caching.
  const fetchCache = new Map<number, Promise<Uint8Array>>()

  function computeBytes(index: number): Promise<Uint8Array> {
    const desc = plan.chunks[index]
    if (!desc) {
      return Promise.reject(
        new Error(`orientChunked: chunk index ${index} out of range`),
      )
    }
    const expectedBytes =
      desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bytesPerVoxel
    if (chunkSource) {
      return Promise.resolve(
        chunkSource({
          chunkIndex: index,
          desc,
          plan,
          datatypeCode: dt,
          bytesPerVoxel,
        }),
      ).then((r) => bytesFromChunkSource(r, expectedBytes))
    }
    const bytes =
      identity || !img2RASstart || !img2RASstep
        ? extractChunkBytes(
            srcBytes as Uint8Array,
            volumeDims,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
          )
        : extractChunkBytesReoriented(
            srcBytes as Uint8Array,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
            img2RASstart,
            img2RASstep,
          )
    return Promise.resolve(bytes)
  }

  function fetchBytes(index: number): Promise<Uint8Array> {
    if (!chunkSource) return computeBytes(index)
    const cached = fetchCache.get(index)
    if (cached) return cached
    const p = computeBytes(index)
    fetchCache.set(index, p)
    // Don't cache rejections: drop the entry so a re-queued chunk retries fresh.
    p.catch(() => {
      if (fetchCache.get(index) === p) fetchCache.delete(index)
    })
    return p
  }

  function prefetchChunk(index: number): void {
    if (!chunkSource) return
    if (fetchCache.has(index)) return
    if (fetchCache.size >= MAX_PREFETCHED_CHUNKS) return
    void fetchBytes(index)
  }

  async function uploadChunk(index: number): Promise<VolumeChunkGPU> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunked: chunk index ${index} out of range`)
    }
    const chunkBytes = await fetchBytes(index)
    // Consumed — free the CPU buffer reference so prefetch headroom recovers.
    fetchCache.delete(index)
    let rgbaTexture: GPUTexture
    if (isRGBA) {
      // Color: write the expanded RGBA8 bytes straight into the output texture.
      rgbaTexture = device.createTexture({
        size: desc.texDims,
        format: 'rgba8unorm',
        dimension: '3d',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      })
      device.queue.writeTexture(
        { texture: rgbaTexture },
        chunkRGBA(chunkBytes, dt) as Uint8Array<ArrayBuffer>,
        { bytesPerRow: desc.texDims[0] * 4, rowsPerImage: desc.texDims[1] },
        desc.texDims,
      )
    } else {
      // Scalar: source-format texture -> orient compute pass -> RGBA8.
      const om = orient as OrientMachinery
      const sourceTexture = device.createTexture({
        size: desc.texDims,
        format: om.format,
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
      rgbaTexture = device.createTexture({
        size: desc.texDims,
        format: 'rgba8unorm',
        dimension: '3d',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
      const bindGroup = device.createBindGroup({
        layout: om.cached.layout,
        entries: [
          { binding: 0, resource: { buffer: om.uniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: om.colormapTexture.createView() },
          { binding: 3, resource: rgbaTexture.createView() },
          { binding: 4, resource: om.sampler },
          { binding: 5, resource: om.negativeColormapTexture.createView() },
        ],
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(om.cached.pipeline)
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
    }

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
    fetchCache.clear()
    if (!orient) return
    orient.uniformBuffer.destroy()
    orient.colormapTexture.destroy()
    if (orient.hasNegativeColormap) orient.negativeColormapTexture.destroy()
  }

  return { uploadChunk, prefetchChunk, dispose }
}

/** Release all per-chunk GPU textures from a previous build. */
export function destroyVolumeChunksGPU(chunks: VolumeChunkGPU[] | null): void {
  if (!chunks) return
  for (const c of chunks) {
    c.volumeTexture.destroy()
    c.volumeGradientTexture.destroy()
  }
}
