import { calculateOverlayTransformMatrix } from '@/math/NVTransforms'
import type { NVImage } from '@/NVTypes'
import { computeNegRange } from '@/view/NVOrient'
import { isRgbaDatatype } from '@/view/NVRenderVolumeData'
import { objectId } from './dataVersion'
import { getTypedArrayConstructor } from './utils'

/** Identity 4x4 (column-major); shared by both backends' modulation prepass. */
export const IDENTITY_MTX = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
])

/** Modulation modes (must match the `modulation`/`modMode` shader uniforms). */
const MOD_RGB = 1
const MOD_ALPHA = 2

/** True for volumes whose colour is pre-baked RGB/RGBA (modulated CPU-side). */
function isRgbaTarget(vol: NVImage): boolean {
  return isRgbaDatatype(vol.hdr.datatypeCode)
}

/** True for label/atlas volumes — the colormap prepass returns before the
 * modulation block, so modulation has no visual effect on them. */
function isLabelTarget(vol: NVImage): boolean {
  return vol.colormapLabel !== null && vol.colormapLabel !== undefined
}

/**
 * Window on |value| for a modulator's negative voxels, or null when it has no
 * negative colormap (negatives then sit below the positive window). As in
 * NiiVue 0.x, a two-sided threshold map modulates by magnitude.
 */
function negativeWindow(mod: NVImage): { min: number; range: number } | null {
  if (!mod.colormapNegative) return null
  const { mnNeg, mxNeg } = computeNegRange(mod)
  const range = mxNeg - mnNeg
  return range > 0 ? { min: -mxNeg, range } : null
}

/**
 * Resolved parameters for sampling a modulator in the scalar colormap prepass:
 * the [0,1] weight (modulator native order), the modulator's native dims, the
 * output->modulator texture matrix, the mode (1=RGB, 2=alpha), and a cache key.
 */
export type ModulationTextureParams = {
  weight: Float32Array
  dims: [number, number, number]
  mtx: Float32Array
  mode: number
  key: string
}

/** Whether a modulation grid fits in a backend's native 3D texture limit. */
export function modulationFitsTextureLimit(
  mod: ModulationTextureParams | null,
  maxTextureDimension3D: number,
): boolean {
  return (
    mod === null ||
    mod.dims.every((dim) => dim > 0 && dim <= maxTextureDimension3D)
  )
}

/**
 * Build the modulation sampling parameters for a target volume, or null when it
 * has no (resolvable) modulator. `baseVol` is the background volume that defines
 * the prepass output grid; the matrix maps that grid to the modulator's native
 * texture coordinates (same convention as the intensity volume's transform).
 */
export function buildModulationParams(
  vol: NVImage,
  baseVol: NVImage,
  volumes: NVImage[],
): ModulationTextureParams | null {
  if (!vol.modulationImage || !vol._modulationWeight) return null
  if (isLabelTarget(vol)) return null // label prepass ignores modulation
  const mod = volumes.find((v) => v.id === vol.modulationImage)
  if (!mod) return null
  const dims: [number, number, number] = [
    mod.hdr.dims[1] ?? 0,
    mod.hdr.dims[2] ?? 0,
    mod.hdr.dims[3] ?? 0,
  ]
  if (vol._modulationWeight.length !== dims[0] * dims[1] * dims[2]) return null
  return {
    weight: vol._modulationWeight,
    dims,
    mtx: calculateOverlayTransformMatrix(baseVol, mod) as Float32Array,
    mode: vol.modulateAlpha ? MOD_ALPHA : MOD_RGB,
    key: vol._modulationWeightKey ?? '',
  }
}

/** Fill RAS-order `result` for a two-sided modulator: negatives use the |value| window. */
function magnitudeDataRAS(
  result: Float32Array,
  mod: NVImage,
  frameOffset: number,
  range: number,
  neg: { min: number; range: number },
): void {
  const imgData = mod.img as unknown as ArrayLike<number>
  const dims = mod.dimsRAS as number[]
  const start = mod.img2RASstart as number[]
  const step = mod.img2RASstep as number[]
  const slope = mod.hdr.scl_slope
  const inter = mod.hdr.scl_inter
  const calMin = mod.calMin
  const negMin = neg.min
  const negRange = neg.range
  let rasIdx = 0
  for (let rz = 0; rz < dims[3]; rz++) {
    for (let ry = 0; ry < dims[2]; ry++) {
      for (let rx = 0; rx < dims[1]; rx++) {
        const nativeIndex =
          start[0] +
          rx * step[0] +
          start[1] +
          ry * step[1] +
          start[2] +
          rz * step[2]
        const scaled = (imgData[nativeIndex + frameOffset] ?? 0) * slope + inter
        const w =
          scaled < 0 ? (-scaled - negMin) / negRange : (scaled - calMin) / range
        result[rasIdx] = w > 0 ? (w > 1 ? 1 : w) : 0
        rasIdx++
      }
    }
  }
}

/**
 * Compute RAS-order modulation data for RGB/RGBA (V1 tensor) targets. Consumed
 * CPU-side in `prepareRGBAData`. Scalar overlays use {@link computeModulationWeights}
 * instead, so non-RGB/RGBA targets are skipped here (the array would be unused).
 */
export function computeModulationData(volumes: NVImage[]): void {
  for (const vol of volumes) {
    if (!vol.modulationImage || !isRgbaTarget(vol)) {
      vol._modulationData = null
      vol._modulationDataKey = undefined
      continue
    }
    const mod = volumes.find((v) => v.id === vol.modulationImage)
    if (!mod?.img || !mod.dimsRAS || !mod.img2RASstep || !mod.img2RASstart) {
      vol._modulationData = null
      vol._modulationDataKey = undefined
      continue
    }
    const hdr = mod.hdr
    const Ctor = getTypedArrayConstructor(hdr.datatypeCode)
    if (!Ctor) {
      vol._modulationData = null
      vol._modulationDataKey = undefined
      continue
    }
    const neg = negativeWindow(mod)
    // Everything the loop below reads. An unchanged key keeps the array, so
    // caches keyed on its identity (rgbaTextureKey) are not invalidated on
    // every GPU update.
    const key = [
      mod.id,
      objectId(mod.img.buffer),
      mod.img.byteOffset,
      mod.img.byteLength,
      mod._dataVersion ?? 0,
      hdr.datatypeCode,
      mod.dimsRAS.join(','),
      mod.img2RASstart.join(','),
      mod.img2RASstep.join(','),
      mod.nVox3D,
      hdr.scl_slope,
      hdr.scl_inter,
      mod.calMin,
      mod.calMax,
      neg?.min,
      neg?.range,
      mod.frame4D ?? 0,
    ].join(':')
    if (vol._modulationData && vol._modulationDataKey === key) continue
    vol._modulationDataKey = key
    const imgData = mod.img
    const dims = mod.dimsRAS
    const nVoxRAS = dims[1] * dims[2] * dims[3]
    const result = new Float32Array(nVoxRAS)
    const slope = hdr.scl_slope
    const inter = hdr.scl_inter
    const range = mod.calMax - mod.calMin
    // `!(range > 0)` also catches NaN windows (range<=0 alone would let NaN through).
    if (!(range > 0)) {
      result.fill(1)
      vol._modulationData = result
      continue
    }
    const frameOffset = (mod.frame4D ?? 0) * mod.nVox3D
    if (neg !== null) {
      magnitudeDataRAS(result, mod, frameOffset, range, neg)
      vol._modulationData = result
      continue
    }
    const start = mod.img2RASstart
    const step = mod.img2RASstep
    let rasIdx = 0
    for (let rz = 0; rz < dims[3]; rz++) {
      for (let ry = 0; ry < dims[2]; ry++) {
        for (let rx = 0; rx < dims[1]; rx++) {
          const nativeIndex =
            start[0] +
            rx * step[0] +
            start[1] +
            ry * step[1] +
            start[2] +
            rz * step[2]
          const raw =
            (imgData as unknown as ArrayLike<number>)[
              nativeIndex + frameOffset
            ] ?? 0
          const scaled = raw * slope + inter
          const w = (scaled - mod.calMin) / range
          // NaN voxel (common in processed float overlays) -> 0, not NaN.
          result[rasIdx] = w > 0 ? (w > 1 ? 1 : w) : 0
          rasIdx++
        }
      }
    }
    vol._modulationData = result
  }
}

/** Fill `weight` for a two-sided modulator: negatives use the |value| window. */
function magnitudeWeights(
  weight: Float32Array,
  imgData: ArrayLike<number>,
  frameOffset: number,
  slope: number,
  inter: number,
  calMin: number,
  range: number,
  neg: { min: number; range: number },
  pow: number,
): void {
  const negMin = neg.min
  const negRange = neg.range
  for (let i = 0; i < weight.length; i++) {
    const scaled = (imgData[i + frameOffset] ?? 0) * slope + inter
    const w =
      scaled < 0 ? (-scaled - negMin) / negRange : (scaled - calMin) / range
    const clamped = w > 0 ? (w > 1 ? 1 : w) : 0
    weight[i] = pow === 1 ? clamped : clamped ** pow
  }
}

/**
 * Compute the scalar-overlay modulation weight for every volume that has
 * `modulationImage` set. Unlike {@link computeModulationData} (RAS order, used
 * by the RGB/RGBA CPU path), this produces a Float32 weight in the MODULATOR's
 * NATIVE voxel order so the scalar colormap prepass can upload it as an R32F
 * texture and sample it through the modulator's overlay transform matrix — the
 * same mechanism the prepass already uses for the intensity volume, so it is
 * correct for any co-registered grid.
 *
 * Weight = clamp((mod*slope+inter - calMin) / (calMax - calMin), 0, 1) ^ pow,
 * where pow = max(1, |modulateAlpha|) (matching the original NiiVue). When the
 * modulator has a negative colormap, a negative value is weighted by its
 * magnitude within the negative window instead. The result
 * is cached on `vol._modulationWeight` keyed by `vol._modulationWeightKey`; the
 * computation is skipped when the key is unchanged.
 */
export function computeModulationWeights(volumes: NVImage[]): void {
  for (const vol of volumes) {
    // RGB/RGBA (V1) targets use the CPU `_modulationData` path; label volumes'
    // colormap prepass returns before the modulation block — skip both here.
    if (!vol.modulationImage || isRgbaTarget(vol) || isLabelTarget(vol)) {
      vol._modulationWeight = null
      vol._modulationWeightKey = undefined
      continue
    }
    const mod = volumes.find((v) => v.id === vol.modulationImage)
    if (!mod?.img) {
      vol._modulationWeight = null
      vol._modulationWeightKey = undefined
      continue
    }
    const hdr = mod.hdr
    const pow = Math.max(1, Math.abs(vol.modulateAlpha ?? 0))
    const neg = negativeWindow(mod)
    // Key on the modulator's data identity (buffer + offset, not just length,
    // plus the in-place edit counter), datatype, native dims, scaling, frame, window, and exponent — so a
    // swapped/rescaled/re-windowed modulator invalidates the cached weight and
    // the GPU texture (whose modKey derives from this key). See audit P2.
    const key = [
      mod.id,
      objectId(mod.img.buffer),
      mod.img.byteOffset,
      mod.img.byteLength,
      mod._dataVersion ?? 0,
      hdr.datatypeCode,
      mod.dims[1],
      mod.dims[2],
      mod.dims[3],
      hdr.scl_slope,
      hdr.scl_inter,
      mod.calMin,
      mod.calMax,
      neg?.min,
      neg?.range,
      mod.frame4D ?? 0,
      pow,
    ].join(':')
    if (vol._modulationWeight && vol._modulationWeightKey === key) {
      continue
    }
    const Ctor = getTypedArrayConstructor(hdr.datatypeCode)
    if (!Ctor) {
      vol._modulationWeight = null
      vol._modulationWeightKey = undefined
      continue
    }
    const imgData = mod.img as unknown as ArrayLike<number>
    const nVox3D = mod.nVox3D
    const frameOffset = (mod.frame4D ?? 0) * nVox3D
    const slope = hdr.scl_slope
    const inter = hdr.scl_inter
    const range = mod.calMax - mod.calMin
    const weight = new Float32Array(nVox3D)
    // `!(range > 0)` also catches NaN windows (range<=0 alone would let NaN through).
    if (!(range > 0)) {
      weight.fill(1)
    } else if (neg === null) {
      for (let i = 0; i < nVox3D; i++) {
        const scaled = (imgData[i + frameOffset] ?? 0) * slope + inter
        // NaN voxel (common in processed float overlays) -> 0, not NaN.
        const w = (scaled - mod.calMin) / range
        const clamped = w > 0 ? (w > 1 ? 1 : w) : 0
        weight[i] = pow === 1 ? clamped : clamped ** pow
      }
    } else {
      magnitudeWeights(
        weight,
        imgData,
        frameOffset,
        slope,
        inter,
        mod.calMin,
        range,
        neg,
        pow,
      )
    }
    vol._modulationWeight = weight
    vol._modulationWeightKey = key
  }
}
