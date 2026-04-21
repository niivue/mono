/**
 * Pure Otsu thresholding functions.
 * Ported from the old niivue ImageProcessing module.
 *
 * These functions are designed to run in a Web Worker (no DOM dependencies).
 */

/**
 * Compute one or more Otsu threshold levels for a volume.
 *
 * Based on:
 * - C: https://github.com/rordenlab/niimath
 * - Java: https://github.com/stevenjwest/Multi_OTSU_Segmentation
 */
export function findOtsu(
  img: ArrayLike<number>,
  calMin: number,
  calMax: number,
  sclInter: number,
  sclSlope: number,
  mlevel = 2,
): number[] {
  const nvox = img.length
  if (nvox < 1) return []

  const nBin = 256
  const maxBin = nBin - 1
  const h = new Array(nBin).fill(0)

  const mn = calMin
  const mx = calMax
  if (mx <= mn) return []

  const scale2raw = (mx - mn) / nBin
  function bin2raw(bin: number): number {
    return bin * scale2raw + mn
  }

  const scale2bin = (nBin - 1) / Math.abs(mx - mn)

  for (let v = 0; v < nvox; v++) {
    let val = img[v] * sclSlope + sclInter
    val = Math.min(Math.max(val, mn), mx)
    val = Math.round((val - mn) * scale2bin)
    h[val]++
  }

  // Build lookup tables P and S
  const P = Array(nBin)
    .fill(0)
    .map(() => Array(nBin).fill(0))
  const S = Array(nBin)
    .fill(0)
    .map(() => Array(nBin).fill(0))

  // Diagonal
  for (let i = 1; i < nBin; ++i) {
    P[i][i] = h[i]
    S[i][i] = i * h[i]
  }

  // Calculate first row
  for (let i = 1; i < nBin - 1; ++i) {
    P[1][i + 1] = P[1][i] + h[i + 1]
    S[1][i + 1] = S[1][i] + (i + 1) * h[i + 1]
  }

  // Using row 1 to calculate others
  for (let i = 2; i < nBin; i++) {
    for (let j = i + 1; j < nBin; j++) {
      P[i][j] = P[1][j] - P[1][i - 1]
      S[i][j] = S[1][j] - S[1][i - 1]
    }
  }

  // Calculate H[i][j]
  for (let i = 1; i < nBin; ++i) {
    for (let j = i + 1; j < nBin; j++) {
      if (P[i][j] !== 0) {
        P[i][j] = (S[i][j] * S[i][j]) / P[i][j]
      }
    }
  }

  let max = 0
  const t = [Infinity, Infinity, Infinity]

  if (mlevel > 3) {
    for (let l = 0; l < nBin - 3; l++) {
      for (let m = l + 1; m < nBin - 2; m++) {
        for (let hIdx = m + 1; hIdx < nBin - 1; hIdx++) {
          const v = P[0][l] + P[l + 1][m] + P[m + 1][hIdx] + P[hIdx + 1][maxBin]
          if (v > max) {
            t[0] = l
            t[1] = m
            t[2] = hIdx
            max = v
          }
        }
      }
    }
  } else if (mlevel === 3) {
    for (let l = 0; l < nBin - 2; l++) {
      for (let hIdx = l + 1; hIdx < nBin - 1; hIdx++) {
        const v = P[0][l] + P[l + 1][hIdx] + P[hIdx + 1][maxBin]
        if (v > max) {
          t[0] = l
          t[1] = hIdx
          max = v
        }
      }
    }
  } else {
    for (let i = 0; i < nBin - 1; i++) {
      const v = P[0][i] + P[i + 1][maxBin]
      if (v > max) {
        t[0] = i
        max = v
      }
    }
  }

  return [bin2raw(t[0]), bin2raw(t[1]), bin2raw(t[2])]
}

/**
 * Apply Otsu thresholds to produce a labeled segmentation.
 */
export function applyOtsu(
  img: ArrayLike<number>,
  thresholds: number[],
): Uint8Array {
  const nvox = img.length
  const out = new Uint8Array(nvox)
  for (let i = 0; i < nvox; i++) {
    const v = img[i]
    if (v > thresholds[0]) out[i] = 1
    if (v > thresholds[1]) out[i] = 2
    if (v > thresholds[2]) out[i] = 3
  }
  return out
}

/**
 * Apply haze removal: zero out voxels below the threshold.
 */
export function applyHazeRemoval(
  img: ArrayLike<number>,
  sclInter: number,
  sclSlope: number,
  globalMin: number,
  threshold: number,
): Float32Array {
  const nvox = img.length
  const out = new Float32Array(nvox)
  for (let i = 0; i < nvox; i++) {
    const val = img[i] * sclSlope + sclInter
    out[i] = val < threshold ? globalMin : (img[i] as number)
  }
  return out
}
