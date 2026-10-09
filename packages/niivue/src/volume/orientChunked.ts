// Backend-agnostic CPU helpers for per-chunk volume extraction.
//
// These pure functions slice a chunk's voxel range out of a contiguous CPU
// image buffer. They are shared by both GPU backends' chunked upload paths
// (wgpu/orientChunked.ts and gl/orientChunked.ts) and have no GPU dependency.

import { colormapKey } from '@/cmap/NVCmaps'
import type { NVImage } from '@/NVTypes'
import { rgbaTextureKey } from '@/view/NVOrient'
import { isRgbaDatatype } from '@/view/NVRenderVolumeData'
import type { ChunkPlan, Vec3i, VolumeChunkDesc } from '@/volume/chunking'
import type { ModulationTextureParams } from '@/volume/modulation'

/** NIfTI datatype codes for color volumes. */
const DT_RGB24 = 128
const DT_RGBA32 = 2304

// Identity tokens for label-colormap objects: a rebuilt LUT (new object) must
// change the display key even if its contents happen to match, and comparing
// contents byte-by-byte per updateVolume would be wasteful.
const _displayObjectIds = new WeakMap<object, number>()
let _nextDisplayObjectId = 1

function displayObjectId(o: object): number {
  let id = _displayObjectIds.get(o)
  if (id === undefined) {
    id = _nextDisplayObjectId++
    _displayObjectIds.set(o, id)
  }
  return id
}

/**
 * Key over every display-affecting input the chunked uploaders bake into their
 * per-chunk orient pass: the colormap LUTs (colormap and negative colormap,
 * each with its addColormap revision, inversion, label LUT identity), the
 * intensity window (calMin/calMax and the negative range), colormapType, the
 * scaling slope/intercept, the 4D frame (the uploaders capture the frame's
 * byte window at creation), and the in-place data version (`_dataVersion`), so
 * an `isDirty` edit of an in-memory chunked volume re-streams its chunks.
 *
 * The renderers compare this against the cached chunked entry's key on every
 * updateVolume: resident chunk textures hold colormapped RGBA, so when any of
 * these change the only way to present the new state is to rebuild the uploader
 * and re-stream the chunks (source bytes are not retained after upload).
 */
export function chunkedDisplayKey(
  nvimage: NVImage,
  modulation: ModulationTextureParams | null = null,
): string {
  const label = nvimage.colormapLabel
  const labelKey = label
    ? `${displayObjectId(label)}:${label.lut ? displayObjectId(label.lut) : ''}`
    : ''
  return [
    colormapKey(nvimage.colormap),
    colormapKey(nvimage.colormapNegative),
    nvimage.isColormapInverted ? 1 : 0,
    labelKey,
    nvimage.calMin,
    nvimage.calMax,
    nvimage.calMinNeg ?? '',
    nvimage.calMaxNeg ?? '',
    nvimage.colormapType ?? 0,
    nvimage.hdr.scl_slope,
    nvimage.hdr.scl_inter,
    nvimage.frame4D ?? 0,
    nvimage._dataVersion ?? 0,
    // Resident chunk textures bake the modulator in, so a modulator that
    // appears, changes or goes away must rebuild the uploader like a colormap
    // change does. `key` already covers the modulator's identity, window,
    // frame and exponent; `mode` covers RGB vs alpha.
    modulation ? `${modulation.key}#${modulation.mode}` : '',
  ].join('|')
}

/**
 * Key over everything a whole-volume texture baked by the orient pass (or, for
 * RGB/RGBA data, by prepareRGBAData) depends on. The multi-instance per-volume
 * `_texCache` entries of both renderers store it and rebuild when it changes,
 * so an edited voxel or modulator (`_dataVersion`, which the modulation key
 * carries too), a new window or frame, a re-registered colormap name, a new
 * label LUT or outline width, a changed modulation mode, or a new affine all
 * show. Scalar volumes use {@link chunkedDisplayKey} (which carries
 * `_dataVersion`), the label outline width
 * (the chunked path never outlines, so that key omits it), the RAS grid and
 * the orient matrix `mtx`, plus the modulator's sampling matrix; RGB/RGBA
 * volumes use rgbaTextureKey, since they bypass the colormap and the matrix.
 */
export function wholeVolumeTextureKey(
  nvimage: NVImage,
  mtx: ArrayLike<number>,
  modulation: ModulationTextureParams | null = null,
): string {
  if (isRgbaDatatype(nvimage.hdr.datatypeCode)) {
    return `rgba|${rgbaTextureKey(nvimage)}`
  }
  const outline = nvimage.colormapLabel
    ? Math.max(0, nvimage.atlasOutline ?? 0)
    : 0
  return [
    outline,
    nvimage.dimsRAS?.slice(1, 4).join('x') ?? '',
    Array.from(mtx).join(','),
    modulation ? Array.from(modulation.mtx).join(',') : '',
    chunkedDisplayKey(nvimage, modulation),
  ].join('|')
}

/**
 * Key over what the coarse floor texture (`setCoarseFloor`, both backends)
 * bakes in when it orients a pyramid level: the source plus
 * {@link chunkedDisplayKey}, the same display inputs (colormaps with their
 * addColormap revision, window, scaling, frame, data version) a chunk bakes.
 */
export function coarseFloorKey(coarseVol: NVImage): string {
  return [coarseVol.url || coarseVol.name, chunkedDisplayKey(coarseVol)].join(
    '|',
  )
}

/** Whether a datatype is a color (RGB/RGBA) source uploaded straight to RGBA8. */
export function isRGBAChunkDatatype(datatypeCode: number): boolean {
  return datatypeCode === DT_RGB24 || datatypeCode === DT_RGBA32
}

/**
 * Convert a chunk's extracted color bytes to RGBA8, the format both backends
 * upload for color volumes. RGB24 (3 bytes/voxel) is expanded with an opaque
 * alpha; RGBA32 (4 bytes/voxel) is already in the target layout and returned
 * as-is. This is the per-chunk analogue of the single-texture `rgba2Texture`
 * bypass — color sources skip the orient/colormap shader entirely.
 *
 * Pure CPU function, exported for unit testing.
 */
export function chunkRGBA(
  chunkBytes: Uint8Array,
  datatypeCode: number,
): Uint8Array {
  if (datatypeCode === DT_RGBA32) return chunkBytes
  if (datatypeCode !== DT_RGB24) {
    throw new Error(`chunkRGBA: datatype ${datatypeCode} is not RGB/RGBA`)
  }
  const voxels = (chunkBytes.length / 3) | 0
  const out = new Uint8Array(voxels * 4)
  for (let v = 0, s = 0, d = 0; v < voxels; v++, s += 3, d += 4) {
    out[d] = chunkBytes[s] ?? 0
    out[d + 1] = chunkBytes[s + 1] ?? 0
    out[d + 2] = chunkBytes[s + 2] ?? 0
    out[d + 3] = 255
  }
  return out
}

/**
 * True when the source image's storage order matches RAS without any permutation
 * or flip — i.e. source voxel (x,y,z) is at CPU offset (z*dy+y)*dx+x.
 *
 * Mirrors the inline check in `prepareRGBAData` (view/NVOrient.ts).
 */
export function isIdentityPermutation(nvimage: NVImage): boolean {
  if (!nvimage.img2RASstep || !nvimage.img2RASstart || !nvimage.dimsRAS) {
    return false
  }
  return (
    nvimage.img2RASstep[0] === 1 &&
    nvimage.img2RASstep[1] === nvimage.dimsRAS[1] &&
    nvimage.img2RASstep[2] === nvimage.dimsRAS[1] * nvimage.dimsRAS[2] &&
    nvimage.img2RASstart[0] === 0 &&
    nvimage.img2RASstart[1] === 0 &&
    nvimage.img2RASstart[2] === 0
  )
}

/**
 * Copy a `texDims`-sized 3D sub-region starting at `texOrigin` out of a
 * contiguous source buffer with row-major (x-fastest) layout. Returns a
 * fresh Uint8Array sized exactly to the chunk extent — no padding.
 *
 * Exported for unit testing. Pure CPU function; no GPU dependencies.
 *
 * @param srcBytes        Source buffer, viewed as bytes (Uint8Array).
 * @param volumeDims      Full volume dims in voxels [dx, dy, dz].
 * @param bytesPerVoxel   Source format byte stride per voxel.
 * @param texOrigin       Chunk's first voxel in volume coords (may equal 0).
 * @param texDims         Chunk extent in voxels (must fit within volumeDims).
 */
export function extractChunkBytes(
  srcBytes: Uint8Array,
  volumeDims: Vec3i,
  bytesPerVoxel: number,
  texOrigin: Vec3i,
  texDims: Vec3i,
): Uint8Array {
  const [dx, dy] = volumeDims
  const [ox, oy, oz] = texOrigin
  const [sx, sy, sz] = texDims
  const out = new Uint8Array(sx * sy * sz * bytesPerVoxel)
  const srcRowStride = dx * bytesPerVoxel
  const srcSliceStride = dx * dy * bytesPerVoxel
  const dstRowStride = sx * bytesPerVoxel
  const dstSliceStride = sx * sy * bytesPerVoxel
  const rowByteLen = sx * bytesPerVoxel
  for (let z = 0; z < sz; z++) {
    const srcZ = oz + z
    const dstZBase = z * dstSliceStride
    const srcZBase = srcZ * srcSliceStride
    for (let y = 0; y < sy; y++) {
      const srcOff = srcZBase + (oy + y) * srcRowStride + ox * bytesPerVoxel
      const dstOff = dstZBase + y * dstRowStride
      out.set(srcBytes.subarray(srcOff, srcOff + rowByteLen), dstOff)
    }
  }
  return out
}

/**
 * Extract a `texDims`-sized chunk while reorienting a non-RAS-aligned source
 * into RAS row-major order. For each RAS voxel in the chunk the native CPU
 * index is `sum(img2RASstart) + x*stepX + y*stepY + z*stepZ` — the same signed
 * permutation `reorientRGBA`/`getVoxel` use. The result is byte-identical to
 * what `extractChunkBytes` would produce from an already-RAS source, so the
 * downstream orient pass runs with the identity matrix.
 *
 * Exported for unit testing. Pure CPU function; no GPU dependencies.
 *
 * @param srcBytes      Source buffer (one 3D frame) viewed as bytes.
 * @param bytesPerVoxel Source format byte stride per voxel.
 * @param texOrigin     Chunk's first RAS voxel in volume coords.
 * @param texDims       Chunk extent in RAS voxels.
 * @param img2RASstart  Per-axis native start offsets (NVImage.img2RASstart).
 * @param img2RASstep   Per-axis native strides, signed (NVImage.img2RASstep).
 */
/**
 * Compose a per-chunk overlay orient matrix.
 *
 * The orient shader (both backends) maps an output normalized coord into the
 * source overlay via `in[k] = sum_j mtx[k*4+j] * coord[j]`. When a chunk is
 * oriented into its own `texDims`-sized output texture, the shader's `coord`
 * is chunk-local. This folds the affine lift `o = coord * scale + offset`
 * (chunk-local [0,1] -> full-volume [0,1]) into `mtx`, so the same shader
 * produces the chunk's slice of the full overlay.
 *
 *   scale[j]  = chunk.texDims[j]   / volumeDims[j]
 *   offset[j] = chunk.texOrigin[j] / volumeDims[j]
 *
 * Convention-independent: only uses the `mtx[k*4+j]` indexing both the GLSL
 * (`coord * mtx`) and WGSL (`dot(mtxRow_k, coord)`) orient passes share.
 *
 * @param mtx     Original 16-element overlay matrix (full-volume orient).
 * @param scale   Per-axis chunk extent fraction of the full volume.
 * @param offset  Per-axis chunk origin fraction of the full volume.
 */
export function chunkOverlayMatrix(
  mtx: Float32Array,
  scale: Vec3i | readonly number[],
  offset: Vec3i | readonly number[],
): Float32Array {
  const out = new Float32Array(16)
  for (let k = 0; k < 4; k++) {
    const b = k * 4
    out[b + 0] = mtx[b + 0] * scale[0]
    out[b + 1] = mtx[b + 1] * scale[1]
    out[b + 2] = mtx[b + 2] * scale[2]
    out[b + 3] =
      mtx[b + 0] * offset[0] +
      mtx[b + 1] * offset[1] +
      mtx[b + 2] * offset[2] +
      mtx[b + 3]
  }
  return out
}

/**
 * Re-target modulation parameters at one chunk's output grid.
 *
 * The orient shaders (both backends) apply the modulation matrix to the same
 * chunk-local output coordinate as the overlay matrix, so a modulator sampled
 * through the full-volume matrix would read the wrong voxels on every chunk
 * but the first. This folds the identical chunk-local -> full-volume lift into
 * `mod.mtx` via {@link chunkOverlayMatrix}; weight, dims, mode and cache key
 * are untouched because the modulator texture itself is whole, not chunked.
 *
 * @param mod     Full-volume modulation params, or null when unmodulated.
 * @param scale   Per-axis chunk extent fraction of the full volume.
 * @param offset  Per-axis chunk origin fraction of the full volume.
 */
export function chunkModulationParams(
  mod: ModulationTextureParams | null,
  scale: Vec3i | readonly number[],
  offset: Vec3i | readonly number[],
): ModulationTextureParams | null {
  if (!mod) return null
  return { ...mod, mtx: chunkOverlayMatrix(mod.mtx, scale, offset) }
}

/**
 * {@link chunkModulationParams} for one brick of a plan. The chunk uploaders
 * orient each brick with an identity matrix, so their output grid IS the
 * brick's texture (`texDims`, halo included, at `texOrigin`), and the lift to
 * the full volume is that box as a fraction of `plan.volumeDims`.
 */
export function chunkModulationForDesc(
  mod: ModulationTextureParams | null,
  desc: VolumeChunkDesc,
  plan: ChunkPlan,
): ModulationTextureParams | null {
  if (!mod) return null
  const [dx, dy, dz] = plan.volumeDims
  const [tx, ty, tz] = desc.texDims
  const [ox, oy, oz] = desc.texOrigin
  return chunkModulationParams(
    mod,
    [tx / dx, ty / dy, tz / dz],
    [ox / dx, oy / dy, oz / dz],
  )
}

export function extractChunkBytesReoriented(
  srcBytes: Uint8Array,
  bytesPerVoxel: number,
  texOrigin: Vec3i,
  texDims: Vec3i,
  img2RASstart: number[],
  img2RASstep: number[],
): Uint8Array {
  const [ox, oy, oz] = texOrigin
  const [sx, sy, sz] = texDims
  const out = new Uint8Array(sx * sy * sz * bytesPerVoxel)
  const startSum = img2RASstart[0] + img2RASstart[1] + img2RASstart[2]
  const [stepX, stepY, stepZ] = img2RASstep
  let dst = 0
  for (let z = 0; z < sz; z++) {
    const baseZ = startSum + (oz + z) * stepZ
    for (let y = 0; y < sy; y++) {
      const baseZY = baseZ + (oy + y) * stepY
      for (let x = 0; x < sx; x++) {
        const srcOff = (baseZY + (ox + x) * stepX) * bytesPerVoxel
        for (let b = 0; b < bytesPerVoxel; b++) {
          out[dst++] = srcBytes[srcOff + b]
        }
      }
    }
  }
  return out
}
