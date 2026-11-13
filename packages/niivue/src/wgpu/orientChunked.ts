// Per-chunk upload + orient + gradient pipeline for tiled volumes.
//
// For each chunk in a ChunkPlan, extracts the chunk's source voxel range
// from the CPU image buffer, uploads it as a per-chunk source 3D texture,
// runs the orient compute pass with identity matrix (output dims == source
// dims), then runs the gradient compute pass on the per-chunk
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
// The orient uniform buffer, colormap textures, modulator texture and sampler
// are shared across chunks (one upload, N bind groups); only the modulation
// matrix is rewritten per chunk, because it maps the chunk's own grid.
// Per-chunk source textures are destroyed after the orient pass; per-chunk
// RGBA + gradient textures are returned to the caller and live for the
// chunk's lifetime in the renderer cache.

import type { ByteLru } from '@/byteLru'
import * as NVCmaps from '@/cmap/NVCmaps'
import { log } from '@/logger'
import type { NVImage } from '@/NVTypes'
import { buildOrientUniforms, labelLutTexels } from '@/view/NVOrient'
import { createChunkFetcher } from '@/volume/chunkFetch'
import type { ChunkPlan, VolumeChunkDesc } from '@/volume/chunking'
import { recordChunkPhase } from '@/volume/chunkTiming'
import {
  type ModulationTextureParams,
  modulationFitsTextureLimit,
} from '@/volume/modulation'
import {
  chunkModulationForDesc,
  chunkRGBA,
  isRGBAChunkDatatype,
} from '@/volume/orientChunked'
import { createModTexture, ensureOrientPipeline } from './orient'
import * as wgpu from './wgpu'

export interface VolumeChunkGPU {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: GPUTexture
  /**
   * RGBA8 gradient texture for this chunk; sized desc.texDims when
   * `hasGradient`, a 1x1x1 placeholder otherwise.
   */
  volumeGradientTexture: GPUTexture
  /**
   * True if `volumeGradientTexture` holds a real computed gradient; false if it
   * is a 1x1x1 zero placeholder (the gradient compute pass was skipped because
   * the volume was unlit at upload). The renderer re-uploads such chunks if
   * lighting is later enabled. Either way it is a real, per-chunk texture that
   * destroyVolumeChunksGPU frees normally.
   */
  hasGradient: boolean
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

// Allocate a 1x1x1 zero RGBA8 3D placeholder gradient texture. WebGPU
// zero-initializes textures, so it samples as zeros; used in place of the
// gradient compute pass when the volume is unlit (no gradient consumer is
// active: gradientAmount, gradientOpacity and silhouettePower are all zero,
// the same rule as the renderer's _needsGradient()): the
// gradient binding must still hold a texture for the bind group layout, but
// the shader only samples it when a gradient consumer is on, so the single
// zero texel is never read — and even a stale mid-transition read decodes to
// the same zeros the old brick-sized empty texture held. Keeping it per-chunk
// (not shared) keeps the bind/destroy path unchanged; at 4 bytes it costs
// nothing, so an unlit chunked volume pays 4 bytes per voxel instead of 8.
function emptyGradientTextureGPU(device: GPUDevice): GPUTexture {
  return device.createTexture({
    size: [1, 1, 1],
    format: 'rgba8unorm',
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
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
  const ab = new ArrayBuffer(12 * 16)
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
  // modMtx (offset 112, 4 vec4s) + mode flag (offset 176): identity + mode 0
  // here; writeChunkModulationUniforms overwrites them per chunk when the
  // volume has a modulator.
  for (let i = 0; i < 16; i++)
    dv.setFloat32(112 + i * 4, IDENTITY_MAT4[i], true)
  dv.setFloat32(176, 0, true)
  // atlasOutline probes neighbours in the SOURCE texture; a chunk's texture is
  // a tile of the volume, so probes at a chunk seam would read the neighbouring
  // chunk's edge and draw a spurious border. Outlining is therefore off for the
  // chunked path.
  dv.setFloat32(180, 0, true)
  device.queue.writeBuffer(uniformBuffer, 0, ab)
}

// Per-chunk modulation uniforms (offsets 112..180 of the orient struct): the
// matrix maps the chunk's output grid to the modulator's texture, so it differs
// per brick even though the modulator texture is shared. Written to the
// shared uniform buffer right before the brick's dispatch; both go through
// the same queue in order, and uploadChunk never awaits between the two.
function writeChunkModulationUniforms(
  device: GPUDevice,
  uniformBuffer: GPUBuffer,
  mod: ModulationTextureParams,
): void {
  const ab = new ArrayBuffer(17 * 4)
  const dv = new DataView(ab)
  for (let i = 0; i < 16; i++) dv.setFloat32(i * 4, mod.mtx[i], true)
  dv.setFloat32(64, mod.mode, true)
  device.queue.writeBuffer(uniformBuffer, 112, ab)
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
    const labelLut = NVCmaps.shownLabelLut(nvimage)?.lut
    if (!labelLut) {
      throw new Error('orientChunked: label colormap LUT is undefined')
    }
    const texels = labelLutTexels(labelLut)
    const labelTex = device.createTexture({
      size: [texels.width, texels.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: labelTex },
      texels.data,
      { bytesPerRow: texels.width * 4, rowsPerImage: texels.height },
      [texels.width, texels.height],
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
    NVCmaps.lutrgba8(nvimage.colormap, nvimage.isColormapInverted),
  )
  const hasNegativeColormap = !!(
    nvimage.colormapNegative && nvimage.colormapNegative.length > 0
  )
  const negativeColormapTexture = hasNegativeColormap
    ? await wgpu.lutBytes2texture(
        device,
        NVCmaps.lutrgba8(nvimage.colormapNegative, nvimage.isColormapInverted),
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
   *
   * `speculative` marks a read the view has NOT asked for -- a prediction of
   * where it is going. Those are held to a lower cap so they can only ever use
   * fetch capacity the working set is leaving idle.
   */
  prefetchChunk(index: number, speculative?: boolean): void
  /**
   * Abandon the source-byte fetch for `index`. A no-op for in-memory volumes
   * and for a chunk with nothing outstanding.
   */
  cancelChunk(index: number): void
  /** Release the shared uniform/colormap GPU resources. */
  dispose(): void
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
  // The orient pass's modulation binding (binding 6): the whole modulator's
  // weights when the volume has one, else a 1x1x1 r32float placeholder (the
  // bind group layout requires the entry either way).
  modTexture: GPUTexture
}

async function buildOrientMachinery(
  device: GPUDevice,
  nvimage: NVImage,
  dt: number,
  modulation: ModulationTextureParams | null,
): Promise<OrientMachinery> {
  const { format, pipelineType } = getTextureFormat(dt)
  const cached = ensureOrientPipeline(device, pipelineType)
  const uniformBuffer = device.createBuffer({
    // 12*16 to match main's orient uniform struct (modMtx at offset 112 +
    // mode flag at 176, rewritten per chunk).
    size: 12 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  writeIdentityOrientUniforms(device, uniformBuffer, nvimage)
  const {
    colormapTexture,
    negativeColormapTexture,
    hasNegativeColormap,
    sampler,
  } = await createColormapResources(device, nvimage)
  const modTexture = createModTexture(device, modulation)
  return {
    format,
    cached,
    uniformBuffer,
    colormapTexture,
    negativeColormapTexture,
    hasNegativeColormap,
    sampler,
    modTexture,
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
  // Whether to compute a real gradient for each chunk. Read per upload so the
  // decision tracks the current lighting; the renderer re-streams the volume when
  // this crosses false->true (see VolumeRendererGPU). Defaults to always-on so
  // existing callers keep prior behavior.
  wantsGradient: () => boolean = () => true,
  // Decoded-chunk tier, owned by the renderer's cache entry so it survives an
  // uploader rebuild (a colormap/window change re-orients bytes it already
  // holds) and can be re-keyed through a plan swap. Never populated for an
  // in-memory volume, whose chunks are a cheap copy out of a buffer we are
  // already holding -- shadowing those would only duplicate the image.
  decoded: ByteLru<number, Uint8Array> | null = null,
  // Resolved modulation for this volume (buildModulationParams against its
  // OWN grid), or null. Baked into every chunk texture like the colormap is,
  // so the renderer's display key must cover it (chunkedDisplayKey).
  modulation: ModulationTextureParams | null = null,
): Promise<ChunkUploaderGPU> {
  if (
    !modulationFitsTextureLimit(modulation, device.limits.maxTextureDimension3D)
  ) {
    log.warn(
      `modulation disabled: grid ${modulation?.dims.join('x')} exceeds WebGPU maxTextureDimension3D (${device.limits.maxTextureDimension3D})`,
    )
    modulation = null
  }
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

  // Scalar volumes orient through a compute pass (source-format texture +
  // colormap -> RGBA8). Color volumes skip all of that, so build the orient
  // machinery only when needed.
  const bytesPerVoxel = isRGBA
    ? dt === 128
      ? 3
      : 4
    : getTextureFormat(dt).bytesPerVoxel
  // Validates the plan, so build it before the orient machinery it would leak.
  const { takeChunkBytes, prefetchChunk, cancelChunk, abortAll } =
    createChunkFetcher(nvimage, plan, bytesPerVoxel, decoded)
  const orient = isRGBA
    ? null
    : await buildOrientMachinery(device, nvimage, dt, modulation)

  async function uploadChunk(index: number): Promise<VolumeChunkGPU> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunked: chunk index ${index} out of range`)
    }
    const chunkBytes = await takeChunkBytes(index)
    // Timed as `upload`: the queue write plus the orient pass, awaited to
    // completion, so this is the part of a chunk's cost that a decode worker
    // could never take off this thread.
    const uploadStart = performance.now()
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
      const chunkMod = chunkModulationForDesc(modulation, desc, plan)
      if (chunkMod) {
        writeChunkModulationUniforms(device, om.uniformBuffer, chunkMod)
      }
      const bindGroup = device.createBindGroup({
        layout: om.cached.layout,
        entries: [
          { binding: 0, resource: { buffer: om.uniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: om.colormapTexture.createView() },
          { binding: 3, resource: rgbaTexture.createView() },
          { binding: 4, resource: om.sampler },
          { binding: 5, resource: om.negativeColormapTexture.createView() },
          { binding: 6, resource: om.modTexture.createView() },
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
    recordChunkPhase(
      'upload',
      performance.now() - uploadStart,
      chunkBytes.byteLength,
    )

    // Skip the gradient compute pass when the volume is unlit; a 1x1x1
    // placeholder keeps the bind/destroy path identical while paying 4 bytes
    // total instead of 4 bytes per voxel.
    const hasGradient = wantsGradient()
    const gradientStart = performance.now()
    const gradientTexture = hasGradient
      ? await wgpu.volume2TextureGradientRGBA(device, rgbaTexture)
      : emptyGradientTextureGPU(device)
    recordChunkPhase('gradient', performance.now() - gradientStart)
    return {
      volumeTexture: rgbaTexture,
      volumeGradientTexture: gradientTexture,
      hasGradient,
      desc,
    }
  }

  function dispose(): void {
    abortAll()
    if (!orient) return
    orient.uniformBuffer.destroy()
    orient.colormapTexture.destroy()
    if (orient.hasNegativeColormap) orient.negativeColormapTexture.destroy()
    orient.modTexture.destroy()
  }

  return { uploadChunk, prefetchChunk, cancelChunk, dispose }
}

/** Release all per-chunk GPU textures from a previous build. */
export function destroyVolumeChunksGPU(chunks: VolumeChunkGPU[] | null): void {
  if (!chunks) return
  for (const c of chunks) {
    c.volumeTexture.destroy()
    c.volumeGradientTexture.destroy()
  }
}
