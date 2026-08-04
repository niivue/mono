/**
 * Region-of-interest statistics over a volume's voxels.
 *
 * Pure and dimension-agnostic: the caller supplies calibrated values (already
 * scaled by `scl_slope`/`scl_inter`), an optional per-voxel mask, and the
 * volume of one voxel. Non-finite values (NaN/Infinity) are excluded, so a
 * volume with NaN padding reports statistics over its real voxels.
 */

/** Summary statistics for a set of voxels. */
export type DescriptiveStats = {
  /** Voxels counted (inside the mask, finite). */
  nVox: number
  mean: number
  /** Sample standard deviation (divides by n-1); 0 when fewer than 2 voxels. */
  stdev: number
  min: number
  max: number
  /** The same statistics restricted to non-zero voxels. */
  nVoxNot0: number
  meanNot0: number
  stdevNot0: number
  minNot0: number
  maxNot0: number
  /** Volume of the counted voxels. */
  volumeMM3: number
  /** `volumeMM3 / 1000` — the unit clinical reports use. */
  volumeML: number
}

const EMPTY_ACC = (): {
  n: number
  sum: number
  min: number
  max: number
} => ({
  n: 0,
  sum: 0,
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
})

/**
 * Compute descriptive statistics over `values`.
 *
 * @param values - calibrated voxel values, any order (order is irrelevant to
 *   the statistics, so the caller may pass native or RAS order).
 * @param voxelVolumeMM3 - volume of a single voxel, used for `volumeMM3`/`volumeML`.
 * @param mask - optional array the same length as `values`; a voxel is counted
 *   only where the mask is non-zero. Omit to count every voxel.
 */
export function computeDescriptiveStats(
  values: ArrayLike<number>,
  voxelVolumeMM3: number,
  mask?: ArrayLike<number> | null,
): DescriptiveStats {
  const all = EMPTY_ACC()
  const not0 = EMPTY_ACC()
  const n = mask ? Math.min(values.length, mask.length) : values.length
  for (let i = 0; i < n; i++) {
    if (mask && mask[i] === 0) continue
    const v = values[i]
    if (!Number.isFinite(v)) continue
    all.n++
    all.sum += v
    if (v < all.min) all.min = v
    if (v > all.max) all.max = v
    if (v !== 0) {
      not0.n++
      not0.sum += v
      if (v < not0.min) not0.min = v
      if (v > not0.max) not0.max = v
    }
  }
  const mean = all.n > 0 ? all.sum / all.n : 0
  const meanNot0 = not0.n > 0 ? not0.sum / not0.n : 0
  // Second pass for the variance: numerically stabler than sum-of-squares minus
  // the squared mean, which cancels catastrophically for large offsets.
  let ss = 0
  let ssNot0 = 0
  for (let i = 0; i < n; i++) {
    if (mask && mask[i] === 0) continue
    const v = values[i]
    if (!Number.isFinite(v)) continue
    const d = v - mean
    ss += d * d
    if (v !== 0) {
      const d0 = v - meanNot0
      ssNot0 += d0 * d0
    }
  }
  const voxVol = Number.isFinite(voxelVolumeMM3) ? voxelVolumeMM3 : 0
  const volumeMM3 = all.n * voxVol
  return {
    nVox: all.n,
    mean,
    stdev: all.n > 1 ? Math.sqrt(ss / (all.n - 1)) : 0,
    min: all.n > 0 ? all.min : 0,
    max: all.n > 0 ? all.max : 0,
    nVoxNot0: not0.n,
    meanNot0,
    stdevNot0: not0.n > 1 ? Math.sqrt(ssNot0 / (not0.n - 1)) : 0,
    minNot0: not0.n > 0 ? not0.min : 0,
    maxNot0: not0.n > 0 ? not0.max : 0,
    volumeMM3,
    volumeML: volumeMM3 / 1000,
  }
}
