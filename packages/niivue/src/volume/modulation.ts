import { calculateOverlayTransformMatrix } from '@/math/NVTransforms'
import type { NVImage } from '@/NVTypes'
import { isRgbaDatatype } from '@/view/NVRenderVolumeData'
import { getTypedArrayConstructor } from './utils'

/** Identity 4x4 (column-major); shared by both backends' modulation prepass. */
export const IDENTITY_MTX = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
])

/** Modulation modes (must match the `modulation`/`modMode` shader uniforms). */
export const MOD_RGB = 1
export const MOD_ALPHA = 2

/** True for volumes whose colour is pre-baked RGB/RGBA (modulated CPU-side). */
function isRgbaTarget(vol: NVImage): boolean {
  return isRgbaDatatype(vol.hdr.datatypeCode)
}

/** True for label/atlas volumes — the colormap prepass returns before the
 * modulation block, so modulation has no visual effect on them. */
function isLabelTarget(vol: NVImage): boolean {
  return vol.colormapLabel !== null && vol.colormapLabel !== undefined
}

// Per-buffer identity tokens so a cache key can detect a swapped/replaced
// modulator buffer even when the new buffer has the same byte length.
const _bufferIds = new WeakMap<object, number>()
let _nextBufferId = 1
function bufferId(buf: ArrayBufferLike): number {
  let id = _bufferIds.get(buf)
  if (id === undefined) {
    id = _nextBufferId++
    _bufferIds.set(buf, id)
  }
  return id
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

/**
 * Compute RAS-order modulation data for RGB/RGBA (V1 tensor) targets. Consumed
 * CPU-side in `prepareRGBAData`. Scalar overlays use {@link computeModulationWeights}
 * instead, so non-RGB/RGBA targets are skipped here (the array would be unused).
 */
export function computeModulationData(volumes: NVImage[]): void {
  for (const vol of volumes) {
    if (!vol.modulationImage || !isRgbaTarget(vol)) {
      vol._modulationData = null
      continue
    }
    const mod = volumes.find((v) => v.id === vol.modulationImage)
    if (!mod?.img || !mod.dimsRAS || !mod.img2RASstep || !mod.img2RASstart) {
      vol._modulationData = null
      continue
    }
    const hdr = mod.hdr
    const Ctor = getTypedArrayConstructor(hdr.datatypeCode)
    if (!Ctor) {
      vol._modulationData = null
      continue
    }
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
    const start = mod.img2RASstart
    const step = mod.img2RASstep
    const frameOffset = (mod.frame4D ?? 0) * mod.nVox3D
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
 * where pow = max(1, |modulateAlpha|) (matching the original NiiVue). The result
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
    // Key on the modulator's data identity (buffer + offset, not just length),
    // datatype, native dims, scaling, frame, window, and exponent — so a
    // swapped/rescaled/re-windowed modulator invalidates the cached weight and
    // the GPU texture (whose modKey derives from this key). See audit P2.
    const key = [
      mod.id,
      bufferId(mod.img.buffer),
      mod.img.byteOffset,
      mod.img.byteLength,
      hdr.datatypeCode,
      mod.dims[1],
      mod.dims[2],
      mod.dims[3],
      hdr.scl_slope,
      hdr.scl_inter,
      mod.calMin,
      mod.calMax,
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
    } else {
      for (let i = 0; i < nVox3D; i++) {
        const scaled = (imgData[i + frameOffset] ?? 0) * slope + inter
        // NaN voxel (common in processed float overlays) -> 0, not NaN.
        const w = (scaled - mod.calMin) / range
        const clamped = w > 0 ? (w > 1 ? 1 : w) : 0
        weight[i] = pow === 1 ? clamped : clamped ** pow
      }
    }
    vol._modulationWeight = weight
    vol._modulationWeightKey = key
  }
}
