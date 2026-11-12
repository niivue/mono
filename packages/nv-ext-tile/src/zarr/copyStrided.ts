// Typed-array surface; `out` and `data` share an element type.
interface Source {
  readonly [i: number]: number
  subarray(begin: number, end: number): ArrayLike<number>
}
interface Target {
  [i: number]: number
  set(array: ArrayLike<number>, offset: number): void
}

// Below this row length a per-element loop beats a subarray + set per row
// (u16 on M-series: set wins from ~48 samples in V8, ~128 in JSC, and loses
// 5-10x at 8).
const MIN_SET_ROW = 64

/**
 * Copy an nx x ny x nz block (`dims`) read with `strides` [sx, sy, sz] into
 * `out` x-fastest, rows `pitchY` and slices `pitchZ` apart; a pitch beyond
 * the block leaves the gaps untouched (zero padding). The strides are fixed
 * per block, so the copy is chosen once, before the loops.
 */
export function copyStrided(
  out: Target,
  data: Source,
  dims: readonly number[],
  strides: readonly number[],
  pitchY: number,
  pitchZ: number,
): void {
  // Indexed, not destructured in the signature: JSC ran that form 2x slower.
  const nx = dims[0]
  const ny = dims[1]
  const nz = dims[2]
  const sx = strides[0]
  const sy = strides[1]
  const sz = strides[2]
  if (sx === 1 && nx >= MIN_SET_ROW) {
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++) {
        const src = z * sz + y * sy
        out.set(data.subarray(src, src + nx), z * pitchZ + y * pitchY)
      }
    return
  }
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      let src = z * sz + y * sy
      let o = z * pitchZ + y * pitchY
      for (let x = 0; x < nx; x++) {
        out[o++] = data[src]
        src += sx
      }
    }
}
