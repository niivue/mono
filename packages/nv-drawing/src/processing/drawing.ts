/**
 * Pure drawing interpolation algorithms.
 * No DOM or Worker dependencies — runs in either main thread or worker.
 */

/** Slice orientation constants (mirrors @niivue/niivue SLICE_TYPE values). */
export const SLICE_TYPE = { AXIAL: 0, CORONAL: 1, SAGITTAL: 2 } as const
export type SliceType = (typeof SLICE_TYPE)[keyof typeof SLICE_TYPE]

export interface DrawingDims {
  dimX: number
  dimY: number
  dimZ: number
}

/**
 * Mapping from RAS voxel coordinates to a flat index in header-space image
 * data. For RAS voxel (rx, ry, rz) the flat index is:
 *   start[0] + rx*step[0] + start[1] + ry*step[1] + start[2] + rz*step[2]
 *
 * When the volume is already in RAS orientation (identity permutation, no
 * flips) this simplifies to the standard row-major layout and can be omitted.
 */
export interface RASIndexMap {
  img2RASstep: number[]
  img2RASstart: number[]
}

export interface InterpolationOptions {
  sliceType?: SliceType
  intensityWeight?: number
  binaryThreshold?: number
  intensitySigma?: number
  applySmoothingToSlices?: boolean
  useIntensityGuided?: boolean
}

// ---------------------------------------------------------------------------
// Slice geometry helpers
// ---------------------------------------------------------------------------

function sliceGeom(sliceType: SliceType, dims: DrawingDims) {
  const { dimX, dimY, dimZ } = dims
  if (sliceType === SLICE_TYPE.AXIAL) return { w: dimX, h: dimY, depth: dimZ }
  if (sliceType === SLICE_TYPE.CORONAL) return { w: dimX, h: dimZ, depth: dimY }
  return { w: dimY, h: dimZ, depth: dimX } // SAGITTAL
}

/** Flat index for RAS voxel (x,y,z) in a RAS-ordered array (like drawBitmap). */
function rasIndex(x: number, y: number, z: number, dims: DrawingDims): number {
  return x + y * dims.dimX + z * dims.dimX * dims.dimY
}

/**
 * Flat index for RAS voxel (rx,ry,rz) in a header-ordered array (like back.img).
 * When no RAS map is provided, assumes header order = RAS order.
 */
function imgIndex(
  rx: number,
  ry: number,
  rz: number,
  dims: DrawingDims,
  rasMap?: RASIndexMap,
): number {
  if (!rasMap) return rasIndex(rx, ry, rz, dims)
  const { img2RASstep: s, img2RASstart: o } = rasMap
  return o[0] + rx * s[0] + o[1] + ry * s[1] + o[2] + rz * s[2]
}

// ---------------------------------------------------------------------------
// Slice extraction / insertion  (bitmap — always RAS-ordered)
// ---------------------------------------------------------------------------

function extractSlice(
  sliceIdx: number,
  sliceType: SliceType,
  data: Uint8Array,
  dims: DrawingDims,
): Float32Array {
  const { dimX, dimY, dimZ } = dims
  if (sliceType === SLICE_TYPE.AXIAL) {
    const out = new Float32Array(dimX * dimY)
    const off = sliceIdx * dimX * dimY
    for (let i = 0; i < out.length; i++) out[i] = data[off + i]
    return out
  }
  if (sliceType === SLICE_TYPE.CORONAL) {
    const out = new Float32Array(dimX * dimZ)
    for (let z = 0; z < dimZ; z++)
      for (let x = 0; x < dimX; x++)
        out[x + z * dimX] = data[rasIndex(x, sliceIdx, z, dims)]
    return out
  }
  // SAGITTAL
  const out = new Float32Array(dimY * dimZ)
  for (let z = 0; z < dimZ; z++)
    for (let y = 0; y < dimY; y++)
      out[y + z * dimY] = data[rasIndex(sliceIdx, y, z, dims)]
  return out
}

// ---------------------------------------------------------------------------
// Intensity slice extraction  (imageData — header-ordered, needs rasMap)
// ---------------------------------------------------------------------------

function extractIntensitySlice(
  sliceIdx: number,
  sliceType: SliceType,
  data: ArrayLike<number>,
  dims: DrawingDims,
  maxVal: number,
  rasMap?: RASIndexMap,
): Float32Array {
  const { dimX, dimY, dimZ } = dims
  const inv = 1 / maxVal
  if (sliceType === SLICE_TYPE.AXIAL) {
    const out = new Float32Array(dimX * dimY)
    for (let y = 0; y < dimY; y++)
      for (let x = 0; x < dimX; x++)
        out[x + y * dimX] = data[imgIndex(x, y, sliceIdx, dims, rasMap)] * inv
    return out
  }
  if (sliceType === SLICE_TYPE.CORONAL) {
    const out = new Float32Array(dimX * dimZ)
    for (let z = 0; z < dimZ; z++)
      for (let x = 0; x < dimX; x++)
        out[x + z * dimX] = data[imgIndex(x, sliceIdx, z, dims, rasMap)] * inv
    return out
  }
  const out = new Float32Array(dimY * dimZ)
  for (let z = 0; z < dimZ; z++)
    for (let y = 0; y < dimY; y++)
      out[y + z * dimY] = data[imgIndex(sliceIdx, y, z, dims, rasMap)] * inv
  return out
}

// ---------------------------------------------------------------------------
// Bitmap insertion (RAS-ordered)
// ---------------------------------------------------------------------------

function insertColorMask(
  mask: Float32Array,
  sliceIdx: number,
  sliceType: SliceType,
  bitmap: Uint8Array,
  dims: DrawingDims,
  threshold: number,
  color: number,
): void {
  const { dimX, dimY, dimZ } = dims
  if (sliceType === SLICE_TYPE.AXIAL) {
    const off = sliceIdx * dimX * dimY
    for (let i = 0; i < mask.length; i++)
      if (mask[i] >= threshold) bitmap[off + i] = color
  } else if (sliceType === SLICE_TYPE.CORONAL) {
    for (let z = 0; z < dimZ; z++)
      for (let x = 0; x < dimX; x++) {
        if (mask[x + z * dimX] >= threshold)
          bitmap[rasIndex(x, sliceIdx, z, dims)] = color
      }
  } else {
    for (let z = 0; z < dimZ; z++)
      for (let y = 0; y < dimY; y++) {
        if (mask[y + z * dimY] >= threshold)
          bitmap[rasIndex(sliceIdx, y, z, dims)] = color
      }
  }
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

function smoothSlice(slice: Float32Array, w: number, h: number): void {
  if (w < 3 || h < 3) return
  const tmp = new Float32Array(slice.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = x + y * w
      tmp[i] =
        x === 0 || x === w - 1
          ? slice[i]
          : (slice[i - 1] + 2 * slice[i] + slice[i + 1]) * 0.25
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = x + y * w
      slice[i] =
        y === 0 || y === h - 1
          ? tmp[i]
          : (tmp[i - w] + 2 * tmp[i] + tmp[i + w]) * 0.25
    }
}

// ---------------------------------------------------------------------------
// Intensity-guided interpolation helpers
// ---------------------------------------------------------------------------

function calculateIntensityWeight(
  intensity1: number,
  intensity2: number,
  targetIntensity: number,
  intensitySigma: number,
): number {
  const diff1 = Math.abs(targetIntensity - intensity1)
  const diff2 = Math.abs(targetIntensity - intensity2)
  const w1 = Math.exp((-diff1 * diff1) / (2 * intensitySigma * intensitySigma))
  const w2 = Math.exp((-diff2 * diff2) / (2 * intensitySigma * intensitySigma))
  const total = w1 + w2
  return total < 1e-6 ? 0.5 : w1 / total
}

// ---------------------------------------------------------------------------
// Public: findBoundarySlices
// ---------------------------------------------------------------------------

/**
 * Find the first and last slices containing drawing data along a given axis.
 */
export function findBoundarySlices(
  sliceType: SliceType,
  drawBitmap: Uint8Array,
  dims: DrawingDims,
): { first: number; last: number } | null {
  const { depth } = sliceGeom(sliceType, dims)
  let first = -1
  let last = -1

  for (let s = 0; s < depth; s++) {
    const slice = extractSlice(s, sliceType, drawBitmap, dims)
    let hasData = false
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] > 0) {
        hasData = true
        break
      }
    }
    if (hasData) {
      if (first === -1) first = s
      last = s
    }
  }

  return first === -1 ? null : { first, last }
}

// ---------------------------------------------------------------------------
// Public: interpolateMaskSlices
// ---------------------------------------------------------------------------

/**
 * Interpolate between drawn slices to fill gaps in the drawing bitmap.
 *
 * The drawing bitmap must be in RAS voxel order (matching the pen tool).
 * The optional imageData may be in header order; pass rasMap to handle
 * the RAS↔header mapping. If rasMap is omitted, imageData is assumed to
 * be in the same order as the bitmap.
 *
 * Modifies `drawBitmap` in-place and returns it.
 */
export function interpolateMaskSlices(
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  imageData: ArrayLike<number> | null,
  maxVal: number,
  sliceIndexLow: number | undefined,
  sliceIndexHigh: number | undefined,
  options: InterpolationOptions,
  rasMap?: RASIndexMap,
): Uint8Array {
  const sliceType = options.sliceType ?? SLICE_TYPE.AXIAL
  const { w, h, depth } = sliceGeom(sliceType, dims)
  const maxSliceIdx = depth - 1

  // Match the original niivue defaults
  const opts = {
    intensityWeight: options.intensityWeight ?? 0.7,
    binaryThreshold: options.binaryThreshold ?? 0.375,
    intensitySigma: options.intensitySigma ?? 0.1,
    applySmoothingToSlices: options.applySmoothingToSlices ?? true,
    useIntensityGuided: options.useIntensityGuided ?? false,
  }

  if (sliceIndexLow !== undefined && sliceIndexHigh !== undefined) {
    if (sliceIndexLow >= sliceIndexHigh)
      throw new Error("Low slice index must be less than high slice index")
    if (sliceIndexLow < 0 || sliceIndexHigh > maxSliceIdx)
      throw new Error(`Slice indices out of bounds [0, ${maxSliceIdx}]`)
  }

  // Scan for per-color slice ranges
  const colorRanges = new Map<number, { min: number; max: number }>()
  for (let s = 0; s <= maxSliceIdx; s++) {
    const slice = extractSlice(s, sliceType, drawBitmap, dims)
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]
      if (c > 0) {
        const r = colorRanges.get(c)
        if (!r) colorRanges.set(c, { min: s, max: s })
        else {
          r.min = Math.min(r.min, s)
          r.max = Math.max(r.max, s)
        }
      }
    }
  }

  for (const [color, range] of colorRanges) {
    const lo =
      sliceIndexLow !== undefined
        ? Math.max(sliceIndexLow, range.min)
        : range.min
    const hi =
      sliceIndexHigh !== undefined
        ? Math.min(sliceIndexHigh, range.max)
        : range.max
    if (lo >= hi || hi - lo < 2) continue

    const sliceLo = extractSlice(lo, sliceType, drawBitmap, dims)
    const sliceHi = extractSlice(hi, sliceType, drawBitmap, dims)

    const maskLo = new Float32Array(sliceLo.length)
    const maskHi = new Float32Array(sliceHi.length)
    for (let i = 0; i < sliceLo.length; i++) {
      maskLo[i] = sliceLo[i] === color ? 1 : 0
      maskHi[i] = sliceHi[i] === color ? 1 : 0
    }

    if (opts.applySmoothingToSlices) {
      smoothSlice(maskLo, w, h)
      smoothSlice(maskHi, w, h)
    }

    for (let z = lo + 1; z < hi; z++) {
      const interp = new Float32Array(w * h)
      const baseFracHi = (z - lo) / (hi - lo)
      const baseFracLo = 1 - baseFracHi

      if (opts.useIntensityGuided && imageData) {
        const intLo = extractIntensitySlice(
          lo,
          sliceType,
          imageData,
          dims,
          maxVal,
          rasMap,
        )
        const intHi = extractIntensitySlice(
          hi,
          sliceType,
          imageData,
          dims,
          maxVal,
          rasMap,
        )
        const intTarget = extractIntensitySlice(
          z,
          sliceType,
          imageData,
          dims,
          maxVal,
          rasMap,
        )
        const alpha = opts.intensityWeight

        for (let i = 0; i < maskLo.length; i++) {
          if (maskLo[i] > 0 || maskHi[i] > 0) {
            const iw = calculateIntensityWeight(
              intLo[i],
              intHi[i],
              intTarget[i],
              opts.intensitySigma,
            )
            const combinedWeightLo = alpha * iw + (1 - alpha) * baseFracLo
            const combinedWeightHi = 1 - combinedWeightLo
            interp[i] =
              maskLo[i] * combinedWeightLo + maskHi[i] * combinedWeightHi
          } else {
            interp[i] = maskLo[i] * baseFracLo + maskHi[i] * baseFracHi
          }
        }
      } else {
        for (let i = 0; i < maskLo.length; i++)
          interp[i] = maskLo[i] * baseFracLo + maskHi[i] * baseFracHi
      }

      insertColorMask(
        interp,
        z,
        sliceType,
        drawBitmap,
        dims,
        opts.binaryThreshold,
        color,
      )
    }
  }

  return drawBitmap
}
