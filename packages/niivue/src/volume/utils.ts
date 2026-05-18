/**
 * Shared utilities for volume processing.
 * Used by NVVolume.ts and volume transforms.
 */

import { mat4, vec3 } from 'gl-matrix'
import { log } from '@/logger'
import { isPaqd, NiiDataType } from '@/NVConstants'
import type {
  NIFTI1,
  NIFTI2,
  NIFTIHeader,
  NVImage,
  TypedVoxelArray,
} from '@/NVTypes'

// ============================================================================
// Data Type Utilities
// ============================================================================

/**
 * Ensures a value is finite and non-zero, returning 1 as fallback.
 */
export function ensureValidNonZero(val: number): number {
  if (val === 0 || !Number.isFinite(val)) {
    return 1
  }
  return val
}

/**
 * Gets the TypedArray constructor for a NIfTI datatype code.
 */
export function getTypedArrayConstructor(
  datatypeCode: number,
):
  | typeof Uint8Array
  | typeof Int16Array
  | typeof Int32Array
  | typeof Float32Array
  | typeof Float64Array
  | typeof Uint16Array
  | typeof Uint32Array
  | typeof Int8Array
  | null {
  switch (datatypeCode) {
    case NiiDataType.DT_UINT8:
      return Uint8Array
    case NiiDataType.DT_INT8:
      return Int8Array
    case NiiDataType.DT_INT16:
      return Int16Array
    case NiiDataType.DT_UINT16:
      return Uint16Array
    case NiiDataType.DT_INT32:
      return Int32Array
    case NiiDataType.DT_UINT32:
      return Uint32Array
    case NiiDataType.DT_FLOAT32:
      return Float32Array
    case NiiDataType.DT_FLOAT64:
      return Float64Array
    default:
      return null
  }
}

/**
 * Gets the number of bits per voxel for a NIfTI datatype code.
 */
export function getBitsPerVoxel(datatypeCode: number): number {
  switch (datatypeCode) {
    case NiiDataType.DT_UINT8:
    case NiiDataType.DT_INT8:
      return 8
    case NiiDataType.DT_INT16:
    case NiiDataType.DT_UINT16:
      return 16
    case NiiDataType.DT_INT32:
    case NiiDataType.DT_UINT32:
    case NiiDataType.DT_FLOAT32:
      return 32
    case NiiDataType.DT_FLOAT64:
      return 64
    case NiiDataType.DT_RGB24:
      return 24
    case NiiDataType.DT_RGBA32:
      return 32
    default:
      return 0
  }
}

// ============================================================================
// Intensity Range Calculation
// ============================================================================

/**
 * Create a typed array view of an ArrayBuffer based on NIfTI datatype code.
 * Returns null for RGB/RGBA types (no per-voxel intensity).
 */
export function toTypedView(
  img: ArrayBuffer | TypedVoxelArray,
  dt: number,
): TypedVoxelArray | null {
  if (!(img instanceof ArrayBuffer)) return img
  const Ctor = getTypedArrayConstructor(dt)
  if (!Ctor) {
    if (dt === NiiDataType.DT_RGB24 || dt === NiiDataType.DT_RGBA32) return null
    throw new Error(`Unsupported datatype: ${dt}`)
  }
  return new Ctor(img)
}

/**
 * Coerce raw NIfTI bytes to a typed view, falling back to a Uint8Array for
 * RGB/RGBA datatypes that have no per-voxel intensity. The fallback matches
 * how loaders treat those bytes elsewhere — `nii2volume` and the deferred-
 * load path in `NVControlBase.loadDeferred4DVolumes` must agree on this
 * shape, so it lives here once.
 */
export function toTypedViewOrU8(
  img: ArrayBuffer | TypedVoxelArray,
  dt: number,
): TypedVoxelArray {
  if (!(img instanceof ArrayBuffer)) return img
  return toTypedView(img, dt) ?? new Uint8Array(img)
}

/**
 * Compute robust (2%–98% histogram percentile) intensity range over a typed array slice.
 * Returns [robust_min, robust_max, global_min, global_max] in raw (unscaled) values.
 */
function robustRange(
  imgRaw: TypedVoxelArray,
  start: number,
  end: number,
): { mn: number; mx: number; nZero: number } | null {
  let mn = Number.POSITIVE_INFINITY
  let mx = Number.NEGATIVE_INFINITY
  let nZero = 0
  for (let i = start; i < end; i++) {
    const v = imgRaw[i]
    if (!Number.isFinite(v)) continue
    if (v === 0) nZero++
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null
  return { mn, mx, nZero }
}

/**
 * Compute 2%/98% histogram percentile bins from a typed array slice.
 * Returns [lo_bin, hi_bin] indices into a 1001-bin histogram.
 */
function histogramPercentiles(
  imgRaw: TypedVoxelArray,
  start: number,
  end: number,
  mn: number,
  mx: number,
  nZero: number,
): [number, number] {
  const nVox = end - start
  const n2pct = Math.round((nVox - nZero) * 0.02)
  const nBins = 1001
  const scl = (nBins - 1) / (mx - mn)
  const hist = new Uint32Array(nBins)
  for (let i = start; i < end; i++) {
    const val = imgRaw[i]
    if (!Number.isFinite(val)) continue
    const b = Math.round((val - mn) * scl)
    hist[b < 0 ? 0 : b >= nBins ? nBins - 1 : b]++
  }
  let n = 0
  let lo = 0
  while (n < n2pct && lo < nBins) {
    n += hist[lo]
    lo++
  }
  lo = Math.max(0, lo - 1)
  n = 0
  let hi = nBins - 1
  while (n < n2pct && hi >= 0) {
    n += hist[hi]
    hi--
  }
  hi = Math.min(nBins - 1, hi + 1)
  if (lo >= hi) {
    lo = 0
    hi = nBins - 1
  }
  return [lo, hi]
}

/**
 * Calculates min/max intensity values from volume data.
 * Returns [robust_min, robust_max, global_min, global_max].
 * Robust values are based on 2%-98% histogram percentiles.
 */
export function calMinMax(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
): [number, number, number, number] {
  const r2c = (v: number) => v * hdr.scl_slope + hdr.scl_inter
  const imgRaw = toTypedView(img, hdr.datatypeCode)
  if (!imgRaw) return [0, 255, 0, 255] // RGB data
  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  const stats = robustRange(imgRaw, 0, nVox3D)
  if (!stats) throw new Error('infinite image')
  const { mn, mx, nZero } = stats
  const mnScale = r2c(mn)
  const mxScale = r2c(mx)
  if (mx === mn) return [mnScale, mxScale, mnScale, mxScale]
  if (
    hdr.cal_min < hdr.cal_max &&
    Number.isFinite(hdr.cal_min) &&
    Number.isFinite(hdr.cal_max)
  ) {
    if (hdr.cal_max > mnScale || hdr.cal_min < mxScale) {
      return [hdr.cal_min, hdr.cal_max, mnScale, mxScale]
    }
  }
  const [lo, hi] = histogramPercentiles(imgRaw, 0, nVox3D, mn, mx, nZero)
  if (lo === hi) return [mnScale, mxScale, mnScale, mxScale]
  const scl = (1001 - 1) / (mx - mn)
  return [r2c(lo / scl + mn), r2c(hi / scl + mn), mnScale, mxScale]
}

/**
 * Calculates robust min/max intensity for a specific 4D frame.
 * Returns [robust_min, robust_max, global_min, global_max].
 * Unlike calMinMax, this always computes the robust range (ignores hdr.cal_min/cal_max).
 */
export function calMinMaxFrame(
  vol: NVImage,
  frame: number,
): [number, number, number, number] {
  const hdr = vol.hdr
  const r2c = (v: number) => v * hdr.scl_slope + hdr.scl_inter
  const imgRaw = toTypedView(vol.img as TypedVoxelArray, hdr.datatypeCode)
  if (!imgRaw) return [0, 255, 0, 255] // RGB data
  const offset = frame * vol.nVox3D
  const end = Math.min(offset + vol.nVox3D, imgRaw.length)
  const stats = robustRange(imgRaw, offset, end)
  if (!stats) return [0, 0, 0, 0]
  const { mn, mx, nZero } = stats
  const mnScale = r2c(mn)
  const mxScale = r2c(mx)
  if (mx === mn) return [mnScale, mxScale, mnScale, mxScale]
  const [lo, hi] = histogramPercentiles(imgRaw, offset, end, mn, mx, nZero)
  if (lo === hi) return [mnScale, mxScale, mnScale, mxScale]
  const scl = (1001 - 1) / (mx - mn)
  return [r2c(lo / scl + mn), r2c(hi / scl + mn), mnScale, mxScale]
}

// ============================================================================
// Spatial Utilities
// ============================================================================

/**
 * Calculates world-space bounding box from volume dimensions and affine.
 */
export function calculateWorldExtents(
  indims: number[],
  inmat: Float32Array,
): { extentsMin: vec3; extentsMax: vec3 } {
  const dims = [indims[0] - 0.5, indims[1] - 0.5, indims[2] - 0.5]
  const v = -0.5
  const mat = mat4.create()
  mat4.transpose(mat, inmat)
  const corners = [
    [v, v, v],
    [dims[0], v, v],
    [v, dims[1], v],
    [dims[0], dims[1], v],
    [v, v, dims[2]],
    [dims[0], v, dims[2]],
    [v, dims[1], dims[2]],
    [dims[0], dims[1], dims[2]],
  ]
  const extentsMin = vec3.fromValues(Infinity, Infinity, Infinity)
  const extentsMax = vec3.fromValues(-Infinity, -Infinity, -Infinity)
  for (const corner of corners) {
    const worldCorner = vec3.create()
    vec3.transformMat4(worldCorner, corner, mat)
    vec3.min(extentsMin, extentsMin, worldCorner)
    vec3.max(extentsMax, extentsMax, worldCorner)
  }
  return { extentsMin, extentsMax }
}

// ============================================================================
// NIfTI Header/File Creation
// ============================================================================

/**
 * Converts a string to a Uint8Array buffer.
 */
function str2Buffer(str: string): Uint8Array {
  const buf = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i)
  }
  return buf
}

/**
 * Creates a minimal NIfTI header with the given parameters.
 */
export function createNiftiHeader(
  dims: number[],
  pixDims: number[],
  affine: number[],
  datatypeCode: number,
): NIFTIHeader {
  const numBitsPerVoxel = getBitsPerVoxel(datatypeCode)

  // Convert flat affine to 4x4 array
  const affine4x4: number[][] = []
  for (let row = 0; row < 4; row++) {
    affine4x4.push([
      affine[row * 4 + 0],
      affine[row * 4 + 1],
      affine[row * 4 + 2],
      affine[row * 4 + 3],
    ])
  }

  return {
    littleEndian: true,
    dim_info: 0,
    dims: [3, dims[0], dims[1], dims[2], 1, 1, 1, 1],
    pixDims: [1, pixDims[0], pixDims[1], pixDims[2], 1, 0, 0, 0],
    intent_p1: 0,
    intent_p2: 0,
    intent_p3: 0,
    intent_code: 0,
    datatypeCode,
    numBitsPerVoxel,
    slice_start: 0,
    vox_offset: 352,
    scl_slope: 1,
    scl_inter: 0,
    slice_end: 0,
    slice_code: 0,
    xyzt_units: 10, // mm + sec
    cal_max: 0,
    cal_min: 0,
    slice_duration: 0,
    toffset: 0,
    description: '',
    aux_file: '',
    qform_code: 0,
    sform_code: 1,
    quatern_b: 0,
    quatern_c: 0,
    quatern_d: 0,
    qoffset_x: 0,
    qoffset_y: 0,
    qoffset_z: 0,
    affine: affine4x4,
    intent_name: '',
    magic: 'n+1',
  }
}

/**
 * Serializes a NIfTI header to a 348-byte Uint8Array.
 */
export function hdrToArrayBuffer(
  hdr: NIFTIHeader,
  isDrawing8 = false,
  isInputEndian = false,
): Uint8Array {
  const SHORT_SIZE = 2
  const FLOAT32_SIZE = 4
  let isLittleEndian = true
  if (isInputEndian) {
    isLittleEndian = hdr.littleEndian
  }
  const byteArray = new Uint8Array(348)
  const view = new DataView(byteArray.buffer)

  // sizeof_hdr
  view.setInt32(0, 348, isLittleEndian)
  // regular set to 'r' (ASCII 114) for Analyze compatibility
  view.setUint8(38, 114)
  // dim_info
  view.setUint8(39, hdr.dim_info)

  // dims
  for (let i = 0; i < 8; i++) {
    view.setUint16(40 + SHORT_SIZE * i, hdr.dims[i], isLittleEndian)
  }

  // intent_p1, intent_p2, intent_p3
  view.setFloat32(56, hdr.intent_p1, isLittleEndian)
  view.setFloat32(60, hdr.intent_p2, isLittleEndian)
  view.setFloat32(64, hdr.intent_p3, isLittleEndian)

  // intent_code, datatype, bitpix, slice_start
  view.setInt16(68, hdr.intent_code, isLittleEndian)
  if (isDrawing8) {
    view.setInt16(70, 2, isLittleEndian) // DT_UINT8
    view.setInt16(72, 8, isLittleEndian)
  } else {
    view.setInt16(70, hdr.datatypeCode, isLittleEndian)
    view.setInt16(72, hdr.numBitsPerVoxel, isLittleEndian)
  }
  view.setInt16(74, hdr.slice_start, isLittleEndian)

  // pixdim[8], vox_offset, scl_slope, scl_inter
  for (let i = 0; i < 8; i++) {
    view.setFloat32(76 + FLOAT32_SIZE * i, hdr.pixDims[i], isLittleEndian)
  }
  if (isDrawing8) {
    view.setFloat32(108, 352, isLittleEndian)
    view.setFloat32(112, 1.0, isLittleEndian)
    view.setFloat32(116, 0.0, isLittleEndian)
  } else {
    view.setFloat32(108, 352, isLittleEndian)
    view.setFloat32(112, hdr.scl_slope, isLittleEndian)
    view.setFloat32(116, hdr.scl_inter, isLittleEndian)
  }

  // slice_end
  view.setInt16(120, hdr.slice_end, isLittleEndian)
  // slice_code, xyzt_units
  view.setUint8(122, hdr.slice_code)
  if (hdr.xyzt_units === 0) {
    view.setUint8(123, 10)
  } else {
    view.setUint8(123, hdr.xyzt_units)
  }

  // cal_max, cal_min, slice_duration, toffset
  if (isDrawing8) {
    view.setFloat32(124, 0, isLittleEndian)
    view.setFloat32(128, 0, isLittleEndian)
  } else {
    view.setFloat32(124, hdr.cal_max, isLittleEndian)
    view.setFloat32(128, hdr.cal_min, isLittleEndian)
  }
  view.setFloat32(132, hdr.slice_duration, isLittleEndian)
  view.setFloat32(136, hdr.toffset, isLittleEndian)

  // descrip and aux_file
  byteArray.set(str2Buffer(hdr.description), 148)
  byteArray.set(str2Buffer(hdr.aux_file), 228)

  // qform_code, sform_code
  view.setInt16(252, hdr.qform_code, isLittleEndian)
  if (hdr.sform_code < 1) {
    view.setInt16(254, 1, isLittleEndian) // default to NIFTI_XFORM_SCANNER_ANAT
  } else {
    view.setInt16(254, hdr.sform_code, isLittleEndian)
  }

  // quatern_b, quatern_c, quatern_d, qoffset_x, qoffset_y, qoffset_z
  view.setFloat32(256, hdr.quatern_b, isLittleEndian)
  view.setFloat32(260, hdr.quatern_c, isLittleEndian)
  view.setFloat32(264, hdr.quatern_d, isLittleEndian)
  view.setFloat32(268, hdr.qoffset_x, isLittleEndian)
  view.setFloat32(272, hdr.qoffset_y, isLittleEndian)
  view.setFloat32(276, hdr.qoffset_z, isLittleEndian)

  // srow_x[4], srow_y[4], srow_z[4]
  const flattened = hdr.affine.flat()
  for (let i = 0; i < 12; i++) {
    view.setFloat32(280 + FLOAT32_SIZE * i, flattened[i], isLittleEndian)
  }

  // magic
  view.setInt32(344, 3222382, true) // "n+1\0"

  return byteArray
}

/**
 * Creates a complete NIfTI file as a Uint8Array (header + image data).
 */
export function createNiftiArray(
  dims: number[] = [256, 256, 256],
  pixDims: number[] = [1, 1, 1],
  affine: number[] = [1, 0, 0, -128, 0, 1, 0, -128, 0, 0, 1, -128, 0, 0, 0, 1],
  datatypeCode = NiiDataType.DT_UINT8,
  img: TypedVoxelArray | Uint8Array = new Uint8Array(),
): Uint8Array {
  const hdr = createNiftiHeader(dims, pixDims, affine, datatypeCode)
  const hdrBytes = hdrToArrayBuffer(hdr, false)

  hdr.vox_offset = Math.max(352, hdrBytes.length)
  const finalHdrBytes = hdrToArrayBuffer(hdr, false)

  if (img.length < 1) {
    return finalHdrBytes
  }

  const paddingSize = Math.max(0, hdr.vox_offset - finalHdrBytes.length)
  const padding = new Uint8Array(paddingSize)
  const imgBytes = new Uint8Array(img.buffer, img.byteOffset, img.byteLength)

  const totalLength = hdr.vox_offset + imgBytes.length
  const outputData = new Uint8Array(totalLength)

  outputData.set(finalHdrBytes, 0)
  outputData.set(padding, finalHdrBytes.length)
  outputData.set(imgBytes, hdr.vox_offset)

  return outputData
}

/**
 * Reorients a drawing bitmap from RAS order back to the volume's native voxel order.
 * If the volume is already in RAS orientation (permRAS = [1,2,3]), returns the input unchanged.
 *
 * Drawing bitmaps are stored in RAS convention. When saving to disk, we need to
 * swizzle them back to match the native voxel layout of the source volume.
 */
export function reorientDrawingToNative(
  volume: NVImage,
  drawingBytes: Uint8Array,
): Uint8Array {
  const perm = volume.permRAS
  if (!perm || (perm[0] === 1 && perm[1] === 2 && perm[2] === 3)) {
    return drawingBytes
  }
  const step = volume.img2RASstep
  const start = volume.img2RASstart
  const dimsRAS = volume.dimsRAS
  if (!step || !start || !dimsRAS) {
    log.warn('Missing RAS transformation info, cannot reorient drawing')
    return drawingBytes
  }
  const dims = volume.hdr.dims
  const nVox = dims[1] * dims[2] * dims[3]
  const nativeData = new Uint8Array(nVox)
  let rasIndex = 0
  for (let rz = 0; rz < dimsRAS[3]; rz++) {
    const zi = start[2] + rz * step[2]
    for (let ry = 0; ry < dimsRAS[2]; ry++) {
      const yi = start[1] + ry * step[1]
      for (let rx = 0; rx < dimsRAS[1]; rx++) {
        const nativeIndex = start[0] + rx * step[0] + yi + zi
        if (nativeIndex >= 0 && nativeIndex < nVox) {
          nativeData[nativeIndex] = drawingBytes[rasIndex]
        }
        rasIndex++
      }
    }
  }
  return nativeData
}

// ============================================================================
// Voxel Value Lookup
// ============================================================================

/**
 * Reads a single voxel value from a volume at RAS voxel coordinates.
 * Applies scl_slope and scl_inter scaling.
 *
 * @param volume - The NVImage to read from
 * @param rx - RAS x voxel coordinate (rounded integer)
 * @param ry - RAS y voxel coordinate (rounded integer)
 * @param rz - RAS z voxel coordinate (rounded integer)
 * @param frame - 4D frame index (default 0)
 * @returns The scaled voxel intensity value, or 0 if out of bounds
 */
export function getVoxelValue(
  volume: NVImage,
  rx: number,
  ry: number,
  rz: number,
  frame = 0,
): number {
  if (
    !volume.img ||
    !volume.dimsRAS ||
    !volume.img2RASstep ||
    !volume.img2RASstart
  )
    return 0
  const dims = volume.dimsRAS
  // Bounds check in RAS space
  if (
    rx < 0 ||
    rx >= dims[1] ||
    ry < 0 ||
    ry >= dims[2] ||
    rz < 0 ||
    rz >= dims[3]
  )
    return 0
  // Compute native flat index from RAS coordinates
  const start = volume.img2RASstart
  const step = volume.img2RASstep
  const nativeIndex =
    start[0] + rx * step[0] + start[1] + ry * step[1] + start[2] + rz * step[2]
  // Frame offset for 4D data
  const offset = nativeIndex + frame * volume.nVox3D
  const imgData = volume.img
  if (offset < 0 || offset >= imgData.length) return 0
  return imgData[offset] * volume.hdr.scl_slope + volume.hdr.scl_inter
}

/**
 * Read 4 raw RGBA bytes at a RAS voxel position (no slope/intercept).
 * Used for PAQD volumes where bytes encode region indices and probabilities.
 */
export function getVoxelRGBA(
  volume: NVImage,
  rx: number,
  ry: number,
  rz: number,
): [number, number, number, number] {
  if (
    !volume.img ||
    !volume.dimsRAS ||
    !volume.img2RASstep ||
    !volume.img2RASstart
  )
    return [0, 0, 0, 0]
  const dims = volume.dimsRAS
  if (
    rx < 0 ||
    rx >= dims[1] ||
    ry < 0 ||
    ry >= dims[2] ||
    rz < 0 ||
    rz >= dims[3]
  )
    return [0, 0, 0, 0]
  const start = volume.img2RASstart
  const step = volume.img2RASstep
  const nativeIndex =
    start[0] + rx * step[0] + start[1] + ry * step[1] + start[2] + rz * step[2]
  const raw = new Uint8Array(
    volume.img.buffer,
    volume.img.byteOffset,
    volume.img.byteLength,
  )
  const byteOffset = nativeIndex * 4
  if (byteOffset < 0 || byteOffset + 3 >= raw.byteLength) return [0, 0, 0, 0]
  return [
    raw[byteOffset],
    raw[byteOffset + 1],
    raw[byteOffset + 2],
    raw[byteOffset + 3],
  ]
}

/**
 * Reorient multi-byte voxel data (RGB or RGBA) from native NIfTI order to RAS order.
 * Uses img2RASstart/img2RASstep mapping (same as getVoxelRGBA for single voxels).
 * @param raw - source bytes in native order
 * @param bpp - bytes per pixel (3 for RGB, 4 for RGBA)
 * @param dimsRAS - RAS dimensions array [_, vx, vy, vz]
 * @param img2RASstart - start offsets for RAS mapping
 * @param img2RASstep - step sizes for RAS mapping
 */
export function reorientRGBA(
  raw: Uint8Array,
  bpp: number,
  dimsRAS: number[],
  img2RASstart: number[],
  img2RASstep: number[],
): Uint8Array {
  const vx = dimsRAS[1]
  const vy = dimsRAS[2]
  const vz = dimsRAS[3]
  const nVox = vx * vy * vz
  const out = new Uint8Array(nVox * bpp)
  for (let z = 0; z < vz; z++) {
    for (let y = 0; y < vy; y++) {
      for (let x = 0; x < vx; x++) {
        const nativeIdx =
          img2RASstart[0] +
          x * img2RASstep[0] +
          img2RASstart[1] +
          y * img2RASstep[1] +
          img2RASstart[2] +
          z * img2RASstep[2]
        const outOff = (x + y * vx + z * vx * vy) * bpp
        const inOff = nativeIdx * bpp
        for (let b = 0; b < bpp; b++) out[outOff + b] = raw[inOff + b]
      }
    }
  }
  return out
}

// ============================================================================
// RAS-ordered intensity data
// ============================================================================

/**
 * Return the volume's 3D voxel data as a Float32Array in RAS voxel order.
 *
 * When the volume's native storage order already matches RAS (identity
 * permutation, no flips), the original `img` data is wrapped directly —
 * zero copies. Otherwise a reordered Float32Array is allocated.
 *
 * The returned array has length `dimsRAS[1] * dimsRAS[2] * dimsRAS[3]`
 * and is indexed as `data[rx + ry*dimX + rz*dimX*dimY]`.
 *
 * Values are **raw** (not scaled by scl_slope/scl_inter).
 */
export function getImageDataRAS(volume: NVImage): Float32Array | null {
  if (
    !volume.img ||
    !volume.dimsRAS ||
    !volume.img2RASstep ||
    !volume.img2RASstart
  ) {
    return null
  }
  const step = volume.img2RASstep
  const start = volume.img2RASstart
  const vx = volume.dimsRAS[1]
  const vy = volume.dimsRAS[2]
  const vz = volume.dimsRAS[3]
  const nVox = vx * vy * vz
  // Identity check: step = [1, dimX, dimX*dimY], start = [0,0,0]
  const isIdentity =
    start[0] === 0 &&
    start[1] === 0 &&
    start[2] === 0 &&
    step[0] === 1 &&
    step[1] === vx &&
    step[2] === vx * vy
  if (
    isIdentity &&
    volume.img instanceof Float32Array &&
    volume.img.length >= nVox
  ) {
    // Zero-copy: img is already Float32 in RAS order
    return volume.img.length === nVox
      ? volume.img
      : volume.img.subarray(0, nVox)
  }
  // Reorder into a new Float32Array
  const src = volume.img
  const out = new Float32Array(nVox)
  let rasIdx = 0
  for (let rz = 0; rz < vz; rz++) {
    const zi = start[2] + rz * step[2]
    for (let ry = 0; ry < vy; ry++) {
      const yi = start[1] + ry * step[1]
      for (let rx = 0; rx < vx; rx++) {
        const nativeIdx = start[0] + rx * step[0] + yi + zi
        out[rasIdx++] = Number(src[nativeIdx])
      }
    }
  }
  return out
}

// ============================================================================
// Label Centroid Computation
// ============================================================================

/**
 * Compute center-of-mass (in mm) for each label region in a volume.
 * For standard label volumes: each voxel with a valid label index contributes equally.
 * For PAQD volumes: each voxel contributes to up to two regions, weighted by probability.
 * Uses inline matRAS multiplication (same as vox2mm) for performance.
 */
export function computeVolumeLabelCentroids(
  volume: NVImage,
): Record<string, [number, number, number]> {
  const lut = volume.colormapLabel
  if (!lut?.labels || !volume.matRAS || !volume.dimsRAS) return {}

  const labels = lut.labels
  const lutMin = lut.min ?? 0
  const lutMax = lut.max ?? labels.length - 1 + lutMin
  const m = volume.matRAS
  const vx = volume.dimsRAS[1],
    vy = volume.dimsRAS[2],
    vz = volume.dimsRAS[3]

  // Accumulators: sum of (mm * weight) and total weight per label
  const sumX: Record<string, number> = {}
  const sumY: Record<string, number> = {}
  const sumZ: Record<string, number> = {}
  const weight: Record<string, number> = {}

  if (isPaqd(volume.hdr)) {
    // PAQD: weight each region by its probability
    for (let rz = 0; rz < vz; rz++) {
      for (let ry = 0; ry < vy; ry++) {
        for (let rx = 0; rx < vx; rx++) {
          const raw = getVoxelRGBA(volume, rx, ry, rz)
          const prob1 = raw[2],
            prob2 = raw[3]
          if (prob1 === 0 && prob2 === 0) continue
          // Inline vox2mm: mm = transpose(matRAS) * [rx,ry,rz,1]
          const mmx = m[0] * rx + m[1] * ry + m[2] * rz + m[3]
          const mmy = m[4] * rx + m[5] * ry + m[6] * rz + m[7]
          const mmz = m[8] * rx + m[9] * ry + m[10] * rz + m[11]
          // Primary region
          const idx1 = raw[0]
          if (prob1 > 0 && idx1 >= lutMin && idx1 <= lutMax) {
            const name = labels[idx1 - lutMin]
            if (name) {
              sumX[name] = (sumX[name] ?? 0) + mmx * prob1
              sumY[name] = (sumY[name] ?? 0) + mmy * prob1
              sumZ[name] = (sumZ[name] ?? 0) + mmz * prob1
              weight[name] = (weight[name] ?? 0) + prob1
            }
          }
          // Secondary region
          const idx2 = raw[1]
          if (prob2 > 0 && idx2 >= lutMin && idx2 <= lutMax) {
            const name = labels[idx2 - lutMin]
            if (name) {
              sumX[name] = (sumX[name] ?? 0) + mmx * prob2
              sumY[name] = (sumY[name] ?? 0) + mmy * prob2
              sumZ[name] = (sumZ[name] ?? 0) + mmz * prob2
              weight[name] = (weight[name] ?? 0) + prob2
            }
          }
        }
      }
    }
  } else {
    // Standard label volume: each voxel contributes equally
    for (let rz = 0; rz < vz; rz++) {
      for (let ry = 0; ry < vy; ry++) {
        for (let rx = 0; rx < vx; rx++) {
          const val = getVoxelValue(volume, rx, ry, rz)
          const labelIdx = Math.round(val)
          if (labelIdx < lutMin || labelIdx > lutMax) continue
          const name = labels[labelIdx - lutMin]
          if (!name) continue
          const mmx = m[0] * rx + m[1] * ry + m[2] * rz + m[3]
          const mmy = m[4] * rx + m[5] * ry + m[6] * rz + m[7]
          const mmz = m[8] * rx + m[9] * ry + m[10] * rz + m[11]
          sumX[name] = (sumX[name] ?? 0) + mmx
          sumY[name] = (sumY[name] ?? 0) + mmy
          sumZ[name] = (sumZ[name] ?? 0) + mmz
          weight[name] = (weight[name] ?? 0) + 1
        }
      }
    }
  }

  const centroids: Record<string, [number, number, number]> = {}
  for (const name of Object.keys(weight)) {
    const w = weight[name]
    if (w > 0) {
      centroids[name] = [sumX[name] / w, sumY[name] / w, sumZ[name] / w]
    }
  }
  return centroids
}

/**
 * Resample raw PAQD RGBA32 bytes into the base volume's coordinate space
 * using nearest-neighbor sampling. This performs
 * NO color lookup or easing — the raw bytes (idx1, idx2, prob1, prob2) are
 * copied directly. GPU shaders perform LUT lookup and easing at render time.
 *
 * @param raw - PAQD overlay bytes in RAS order (4 bytes per voxel: R=idx1, G=idx2, B=prob1, A=prob2)
 * @param dimsOut - output dimensions [vx, vy, vz] (base volume RAS dims)
 * @param ovDims - overlay dimensions [vx, vy, vz] (PAQD volume RAS dims)
 * @param mtx - 4x4 overlay transform matrix (column-major, from calculateOverlayTransformMatrix)
 */
export function paqdResampleRaw(
  raw: Uint8Array,
  dimsOut: number[],
  ovDims: number[],
  mtx: Float32Array,
): Uint8Array {
  const [vxOut, vyOut, vzOut] = dimsOut
  const [vxOv, vyOv, vzOv] = ovDims
  const nVoxOut = vxOut * vyOut * vzOut
  const out = new Uint8Array(nVoxOut * 4)
  for (let z = 0; z < vzOut; z++) {
    const fz = (z + 0.5) / vzOut
    for (let y = 0; y < vyOut; y++) {
      const fy = (y + 0.5) / vyOut
      for (let x = 0; x < vxOut; x++) {
        const fx = (x + 0.5) / vxOut
        const ox = fx * mtx[0] + fy * mtx[1] + fz * mtx[2] + mtx[3]
        const oy = fx * mtx[4] + fy * mtx[5] + fz * mtx[6] + mtx[7]
        const oz = fx * mtx[8] + fy * mtx[9] + fz * mtx[10] + mtx[11]
        const outOff = (x + y * vxOut + z * vxOut * vyOut) * 4
        if (ox < 0 || ox > 1 || oy < 0 || oy > 1 || oz < 0 || oz > 1) {
          continue // out array is zero-initialized
        }
        const ix = Math.min(Math.floor(ox * vxOv), vxOv - 1)
        const iy = Math.min(Math.floor(oy * vyOv), vyOv - 1)
        const iz = Math.min(Math.floor(oz * vzOv), vzOv - 1)
        const inOff = (ix + iy * vxOv + iz * vxOv * vyOv) * 4
        out[outOff] = raw[inOff]
        out[outOff + 1] = raw[inOff + 1]
        out[outOff + 2] = raw[inOff + 2]
        out[outOff + 3] = raw[inOff + 3]
      }
    }
  }
  return out
}

/**
 * Build a 256-entry padded RGBA LUT from a colormapLabel.
 * Entry i maps label index i → RGBA color. Indices outside the source range
 * are transparent (0,0,0,0). This eliminates labelMin from shader uniforms.
 *
 * @param lut - Source LUT (RGBA8, 4 bytes per entry)
 * @param lutMin - Minimum label index in source LUT
 */
export function buildPaqdLut256(
  lut: Uint8ClampedArray,
  lutMin: number,
): Uint8Array {
  const out = new Uint8Array(256 * 4) // zero-initialized (transparent)
  const srcLen = lut.length / 4
  for (let i = 0; i < srcLen; i++) {
    const destIdx = lutMin + i
    if (destIdx >= 0 && destIdx < 256) {
      const dOff = destIdx * 4
      const sOff = i * 4
      out[dOff] = lut[sOff]
      out[dOff + 1] = lut[sOff + 1]
      out[dOff + 2] = lut[sOff + 2]
      out[dOff + 3] = lut[sOff + 3]
    }
  }
  return out
}
