import type { NVImage } from '@niivue/niivue'

// PET quantification on NiiVue volumes, as cornerstone computes it for OHIF's
// TMTV and 4D workflows. Masks are Uint8 labels in a volume's RAS voxel order
// (NiiVue's drawing order); values are read from the native `img` through the
// RAS strides, raw, and scaled (scl_slope/inter) outside the voxel loops.

/** RAS voxel (x,y,z) -> native index start + x*step[0] + y*step[1] + z*step[2]. */
export interface RasGrid {
  dims: [number, number, number]
  start: number
  step: [number, number, number]
  /** RAS voxel -> mm, row-major 3x4. */
  affine: number[]
}

/** A volume's raw voxels with their scaling. */
export interface Sampled {
  data: ArrayLike<number>
  grid: RasGrid
  slope: number
  inter: number
  /** Cornerstone's voxel index order (default: the native order). */
  ijk?: IjkAxes
}

/**
 * Cornerstone's (DICOM) voxel index axes on a RAS grid: index axis d runs
 * along RAS axis `axis[d]`; `dir[a]` is +1 where RAS axis a runs with its index.
 */
export interface IjkAxes {
  axis: [number, number, number]
  dir: [number, number, number]
}

/**
 * From ImageOrientationPatient (cornerstone's k runs along row x column), else
 * the native order: dcm2niix flips rows, so its order differs from DICOM's.
 */
export function ijkAxes(grid: RasGrid, iop?: ArrayLike<number>): IjkAxes {
  if (iop && iop.length >= 6) {
    const [r0 = 0, r1 = 0, r2 = 0, c0 = 0, c1 = 0, c2 = 0] = Array.from(iop)
    // Row, column and their cross product, LPS -> RAS.
    const ras = [
      [-r0, -r1, r2],
      [-c0, -c1, c2],
      [c1 * r2 - r1 * c2, r0 * c2 - r2 * c0, r0 * c1 - r1 * c0],
    ] as number[][]
    const axis = ras.map((u) => {
      let a = 0
      for (let r = 1; r < 3; r++)
        if (Math.abs(u[r] as number) > Math.abs(u[a] as number)) a = r
      return a
    }) as IjkAxes['axis']
    const dir = [1, 1, 1] as IjkAxes['dir']
    for (const [d, a] of axis.entries())
      dir[a] = ((ras[d] as number[])[a] as number) < 0 ? -1 : 1
    // A 45 degree oblique has no dominant axis: fall back to the native order.
    if (new Set(axis).size === 3) return { axis, dir }
  }
  const { step } = grid
  const axis = [0, 1, 2].sort(
    (a, b) => Math.abs(step[a] as number) - Math.abs(step[b] as number),
  ) as IjkAxes['axis']
  const dir = step.map((s) => (s < 0 ? -1 : 1)) as IjkAxes['dir']
  return { axis, dir }
}

type Vec3 = [number, number, number]

/** Inclusive RAS voxel box [x0, x1, y0, y1, z0, z1]. */
export type Box = [number, number, number, number, number, number]

export function rasGrid(v: NVImage): RasGrid | undefined {
  const d = v.dimsRAS
  const s = v.img2RASstep
  const o = v.img2RASstart
  const m = v.matRAS
  if (!d || !s || !o || !m) return undefined
  return {
    dims: [d[1] ?? 1, d[2] ?? 1, d[3] ?? 1],
    start: (o[0] ?? 0) + (o[1] ?? 0) + (o[2] ?? 0),
    step: [s[0] ?? 1, s[1] ?? 0, s[2] ?? 0],
    affine: Array.from(m).slice(0, 12),
  }
}

/** `data` (default: the volume's shown frame) as a Sampled. */
export function sampled(
  v: NVImage,
  data: ArrayLike<number> | undefined = v.img ?? undefined,
): Sampled | undefined {
  const grid = rasGrid(v)
  if (!grid || !data) return undefined
  return {
    data,
    grid,
    slope: v.hdr?.scl_slope || 1,
    inter: v.hdr?.scl_inter || 0,
  }
}

const apply = (m: number[], p: ArrayLike<number>, r: number) =>
  (m[r * 4] as number) * (p[0] as number) +
  (m[r * 4 + 1] as number) * (p[1] as number) +
  (m[r * 4 + 2] as number) * (p[2] as number) +
  (m[r * 4 + 3] as number)

export const vox2mm = (g: RasGrid, v: ArrayLike<number>): number[] => [
  apply(g.affine, v, 0),
  apply(g.affine, v, 1),
  apply(g.affine, v, 2),
]

/** Inverse of a row-major 3x4 affine. */
export function invertAffine(m: number[]): number[] {
  const [a = 0, b = 0, c = 0, tx = 0, d = 0, e = 0, f = 0, ty = 0] = m
  const [g = 0, h = 0, i = 0, tz = 0] = m.slice(8)
  const A = e * i - f * h
  const B = f * g - d * i
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const r = [
    A,
    c * h - b * i,
    b * f - c * e,
    0,
    B,
    a * i - c * g,
    c * d - a * f,
    0,
    C,
    b * g - a * h,
    a * e - b * d,
    0,
  ].map((x) => x / det)
  for (let row = 0; row < 3; row++)
    r[row * 4 + 3] = -(
      (r[row * 4] as number) * tx +
      (r[row * 4 + 1] as number) * ty +
      (r[row * 4 + 2] as number) * tz
    )
  return r
}

/** a then b: row-major 3x4 product b * a. */
function compose(b: number[], a: number[]): number[] {
  const r: number[] = []
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 4; col++)
      r.push(
        (b[row * 4] as number) * (a[col] as number) +
          (b[row * 4 + 1] as number) * (a[4 + col] as number) +
          (b[row * 4 + 2] as number) * (a[8 + col] as number) +
          (col === 3 ? (b[row * 4 + 3] as number) : 0),
      )
  return r
}

/** Voxel edge lengths (mm) along the grid's RAS axes. */
export const spacing = (g: RasGrid): [number, number, number] =>
  [0, 1, 2].map((c) =>
    Math.hypot(
      g.affine[c] as number,
      g.affine[4 + c] as number,
      g.affine[8 + c] as number,
    ),
  ) as [number, number, number]

export const voxelMM3 = (g: RasGrid): number => {
  const [x, y, z] = spacing(g)
  return x * y * z
}

/**
 * The rectangle `rect` (mm corners) at each slice of a
 * RectangleROIStartEndThreshold: from `start` toward `end` along world axis
 * `axis`, every `step` mm while short of |end - start| (cornerstone's
 * projection points).
 */
export function slabCorners(
  rect: ReadonlyArray<ArrayLike<number>>,
  axis: number,
  start: number,
  end: number,
  step: number,
): number[][] {
  const out: number[][] = []
  const span = Math.abs(end - start)
  const dir = Math.sign(end - start)
  for (let d = 0; d < span; d += step)
    for (const p of rect) {
      const q = Array.from(p)
      q[axis] = start + dir * d
      out.push(q)
    }
  return out
}

/** Rounded, clamped voxel box around mm points (cornerstone's getBoundingBoxAroundShapeIJK). */
export function boxAround(
  pointsMM: ReadonlyArray<ArrayLike<number>>,
  g: RasGrid,
): Box {
  const inv = invertAffine(g.affine)
  const box: Box = [
    Number.POSITIVE_INFINITY,
    0,
    Number.POSITIVE_INFINITY,
    0,
    Number.POSITIVE_INFINITY,
    0,
  ]
  for (const p of pointsMM)
    for (let a = 0; a < 3; a++) {
      const v = Math.round(apply(inv, p, a))
      box[2 * a] = Math.min(box[2 * a] as number, v)
      box[2 * a + 1] = Math.max(box[2 * a + 1] as number, v)
    }
  for (let a = 0; a < 3; a++) {
    box[2 * a] = Math.max(0, box[2 * a] as number)
    box[2 * a + 1] = Math.min(
      (g.dims[a] as number) - 1,
      box[2 * a + 1] as number,
    )
  }
  // A fresh int array (one seeded with Infinity stays double-typed and slows
  // the voxel loops); no points: empty.
  return pointsMM.length ? (box.map((v) => v | 0) as Box) : [1, 0, 1, 0, 1, 0]
}

/** Raw-domain lo (hi when `upper`) of a scaled (lower, upper). */
function rawBound(v: Sampled, lower: number, upper: number, isHi: boolean) {
  const a = (lower - v.inter) / v.slope
  const b = (upper - v.inter) / v.slope
  return v.slope > 0 === isHi ? b : a
}

/** Largest scaled value in `box` (OHIF's Max% reference). */
export function boxMax(v: Sampled, box: Box): number {
  const { data, grid } = v
  const [sx, sy, sz] = grid.step
  let max = Number.NEGATIVE_INFINITY
  let min = Number.POSITIVE_INFINITY
  for (let z = box[4]; z <= box[5]; z++)
    for (let y = box[2]; y <= box[3]; y++) {
      const row = grid.start + y * sy + z * sz
      for (let x = box[0]; x <= box[1]; x++) {
        const r = data[row + x * sx] as number
        if (r > max) max = r
        if (r < min) min = r
      }
    }
  return v.slope > 0 ? max * v.slope + v.inter : min * v.slope + v.inter
}

export interface CtRange {
  ct: Sampled
  lower: number
  upper: number
}

/**
 * cornerstone's thresholdVolumeByRange with overwrite: clears `value` from
 * `label` (PT grid; one value per OHIF segmentation) and sets it on box voxels with lower < PT < upper and, given `ct`, some
 * CT voxel overlapping the PT voxel within [ct.lower, ct.upper]. Returns the
 * voxels set.
 */
export function thresholdBox(
  label: Uint8Array,
  pt: Sampled,
  box: Box,
  lower: number,
  upper: number,
  value: number,
  ct?: CtRange,
): number {
  for (let i = 0; i < label.length; i++) if (label[i] === value) label[i] = 0
  const { data, grid } = pt
  const [nx, ny] = grid.dims
  const [sx, sy, sz] = grid.step
  const lo = rawBound(pt, lower, upper, false)
  const hi = rawBound(pt, lower, upper, true)
  const ctTest = ct && ctOverlap(pt.grid, ct)
  if (!ctTest)
    return thresholdLoop(
      label,
      data,
      box,
      grid.start,
      sx,
      sy,
      sz,
      nx,
      ny,
      lo,
      hi,
      value,
    )
  let n = 0
  for (let z = box[4]; z <= box[5]; z++)
    for (let y = box[2]; y <= box[3]; y++) {
      const row = grid.start + y * sy + z * sz
      const out = (z * ny + y) * nx
      for (let x = box[0]; x <= box[1]; x++) {
        const r = data[row + x * sx] as number
        if (r > lo && r < hi && ctTest(x, y, z)) {
          label[out + x] = value
          n++
        }
      }
    }
  return n
}

// The PT-only loop, without the CT closure: with it in the loop JSC ran ~3x
// slower even when unset (bench/quant.bench.ts).
function thresholdLoop(
  label: Uint8Array,
  data: ArrayLike<number>,
  box: Box,
  start: number,
  sx: number,
  sy: number,
  sz: number,
  nx: number,
  ny: number,
  lo: number,
  hi: number,
  value: number,
): number {
  let n = 0
  for (let z = box[4]; z <= box[5]; z++)
    for (let y = box[2]; y <= box[3]; y++) {
      const row = start + y * sy + z * sz
      const out = (z * ny + y) * nx
      for (let x = box[0]; x <= box[1]; x++) {
        const r = data[row + x * sx] as number
        if (r > lo && r < hi) {
          label[out + x] = value
          n++
        }
      }
    }
  return n
}

/** Whether a CT voxel overlapping PT voxel (x,y,z) is in range (cornerstone's overlapType 0). */
function ctOverlap(ptGrid: RasGrid, { ct, lower, upper }: CtRange) {
  const m = compose(invertAffine(ct.grid.affine), ptGrid.affine)
  // Half extent of a PT voxel along each CT axis.
  const ext = [0, 1, 2].map(
    (r) =>
      0.5 *
      (Math.abs(m[r * 4] as number) +
        Math.abs(m[r * 4 + 1] as number) +
        Math.abs(m[r * 4 + 2] as number)),
  ) as Vec3
  const { data, grid } = ct
  // Cornerstone rounds in the CT's own index order, so a half-voxel end along
  // a RAS axis run backwards rounds down: shift the centre by a hair there.
  // ponytail: exact to 1e-6 voxel, below cornerstone's own float error.
  const { dir } = ct.ijk ?? ijkAxes(grid)
  for (let r = 0; r < 3; r++)
    if ((dir[r] as number) < 0) m[r * 4 + 3] = (m[r * 4 + 3] as number) - 1e-6
  const lo = rawBound(ct, lower, upper, false)
  const hi = rawBound(ct, lower, upper, true)
  const [nx, ny, nz] = grid.dims
  const [sx, sy, sz] = grid.step
  const p = [0, 0, 0]
  return (x: number, y: number, z: number): boolean => {
    p[0] = x
    p[1] = y
    p[2] = z
    const cx = apply(m, p, 0)
    const cy = apply(m, p, 1)
    const cz = apply(m, p, 2)
    const x0 = Math.max(0, Math.round(cx - ext[0]))
    const x1 = Math.min(nx - 1, Math.round(cx + ext[0]))
    const y0 = Math.max(0, Math.round(cy - ext[1]))
    const y1 = Math.min(ny - 1, Math.round(cy + ext[1]))
    const z0 = Math.max(0, Math.round(cz - ext[2]))
    const z1 = Math.min(nz - 1, Math.round(cz + ext[2]))
    for (let k = z0; k <= z1; k++)
      for (let j = y0; j <= y1; j++) {
        const row = grid.start + j * sy + k * sz
        for (let i = x0; i <= x1; i++) {
          const r = data[row + i * sx] as number
          if (r >= lo && r <= hi) return true
        }
      }
    return false
  }
}

export interface SegmentStats {
  count: number
  /** mm³ (cornerstone's volume stat). */
  volume: number
  mean: number
  max: number
  min: number
  /** Mean in a 1 mL sphere around the hottest voxels (cornerstone's peakValue). */
  peak: number
  /** volume (mm³) x mean, as cornerstone's per-segment lesionGlycolysis. */
  lesionGlycolysis: number
}

// cornerstone's VolumetricCalculator: SUVpeak tests the 10 hottest voxels.
const PEAK_CANDIDATES = 10
const RADIUS_1ML = ((3 * 1000) / (4 * Math.PI)) ** (1 / 3)

/** cornerstone's volumetricStatsCallback: a tie with the hottest goes last, others before their equals. */
function addCandidate(top: number[], at: number[], s: number, i: number) {
  const m = top.length
  const slot =
    m && s < (top[m - 1] as number) ? top.findIndex((t) => s <= t) : m
  top.splice(slot, 0, s)
  at.splice(slot, 0, i)
  if (m === PEAK_CANDIDATES) {
    top.shift()
    at.shift()
  }
}

/** Stats of `label` voxels equal to `value` over `v` (on the label's grid). */
export function segmentStats(
  label: Uint8Array,
  v: Sampled,
  value: number,
): SegmentStats | undefined {
  const { data, grid } = v
  const [nx, ny] = grid.dims
  const sign = v.slope > 0 ? 1 : -1
  let n = 0
  let sum = 0
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  // Hottest voxels (raw x sign, ascending) and their label indices.
  const top: number[] = []
  const at: number[] = []
  // Visit voxels in cornerstone's index order (i fastest), which decides
  // which tied maxima stay candidates: label and data offsets per index step.
  const { axis, dir } = v.ijk ?? ijkAxes(grid)
  const labelStep = [1, nx, nx * ny]
  type Stride = [number, number, number, number, number]
  const strides = axis.map((a): Stride => {
    const s = dir[a] as number
    const ls = labelStep[a] as number
    const ds = grid.step[a] as number
    // An axis run backwards starts at its last voxel.
    const start = s < 0 ? (grid.dims[a] as number) - 1 : 0
    // `| 0`: int strides keep the typed-array indices int (as doubles, the scan ran 2x slower).
    const n = grid.dims[a] as number
    return [
      n | 0,
      (s * ls) | 0,
      (s * ds) | 0,
      (start * ls) | 0,
      (start * ds) | 0,
    ]
  })
  const [[ni, li, di, l0, d0], [nj, lj, dj, l1, d1], [nk, lk, dk, l2, d2]] =
    strides as [Stride, Stride, Stride]
  const label0 = (l0 + l1 + l2) | 0
  const data0 = (grid.start + d0 + d1 + d2) | 0
  for (let k = 0; k < nk; k++)
    for (let j = 0; j < nj; j++) {
      let l = label0 + j * lj + k * lk
      let d = data0 + j * dj + k * dk
      for (let i = 0; i < ni; i++, l += li, d += di) {
        if (label[l] !== value) continue
        const r = data[d] as number
        n++
        sum += r
        if (r < lo) lo = r
        if (r > hi) hi = r
        const s = r * sign
        if (top.length < PEAK_CANDIDATES || s >= (top[0] as number))
          addCandidate(top, at, s, l)
      }
    }
  if (!n) return undefined
  const scale = (r: number) => r * v.slope + v.inter
  const mean = scale(sum / n)
  const volume = n * voxelMM3(grid)
  const radius = spacing(grid).map((s) =>
    Math.max(1, Math.round((1.1 * RADIUS_1ML) / s)),
  ) as [number, number, number]
  let peak = Number.NEGATIVE_INFINITY
  for (const c of at) {
    const m = sphereMean(
      v,
      c % nx,
      Math.floor(c / nx) % ny,
      Math.floor(c / (nx * ny)),
      radius,
    )
    if (m >= peak) peak = m
  }
  const [min, max] = sign > 0 ? [scale(lo), scale(hi)] : [scale(hi), scale(lo)]
  return {
    count: n,
    volume,
    mean,
    max,
    min,
    peak,
    lesionGlycolysis: volume * mean,
  }
}

/** Scaled mean over the voxel ellipsoid of `radius` voxels around (cx,cy,cz), clipped to the grid. */
function sphereMean(
  v: Sampled,
  cx: number,
  cy: number,
  cz: number,
  [rx, ry, rz]: [number, number, number],
): number {
  const { data, grid } = v
  const [nx, ny, nz] = grid.dims
  const [sx, sy, sz] = grid.step
  let n = 0
  let sum = 0
  for (let z = Math.max(0, cz - rz); z <= Math.min(nz - 1, cz + rz); z++)
    for (let y = Math.max(0, cy - ry); y <= Math.min(ny - 1, cy + ry); y++) {
      const row = grid.start + y * sy + z * sz
      for (let x = Math.max(0, cx - rx); x <= Math.min(nx - 1, cx + rx); x++) {
        const d =
          ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2
        if (d > 1) continue
        sum += data[row + x * sx] as number
        n++
      }
    }
  return (sum / n) * v.slope + v.inter
}

/**
 * `label` (on `from`) at each RAS voxel centre of `to`: the nearest `from`
 * voxel, 0 outside. Copies when the grids match.
 */
export function resampleLabel(
  label: Uint8Array,
  from: RasGrid,
  to: RasGrid,
  // Values for `to` voxels outside `from` (default 0).
  outside?: Uint8Array,
): Uint8Array {
  const [fx, fy, fz] = from.dims
  const [tx, ty, tz] = to.dims
  const out = outside ? outside.slice() : new Uint8Array(tx * ty * tz)
  const m = compose(invertAffine(from.affine), to.affine)
  if (
    fx === tx &&
    fy === ty &&
    fz === tz &&
    m.every((x, k) => Math.abs(x - (k % 5 === 0 ? 1 : 0)) < 1e-4)
  ) {
    out.set(label)
    return out
  }
  // Affine: step the source position by m's columns along x.
  let i = 0
  for (let z = 0; z < tz; z++)
    for (let y = 0; y < ty; y++) {
      let px = (m[1] as number) * y + (m[2] as number) * z + (m[3] as number)
      let py = (m[5] as number) * y + (m[6] as number) * z + (m[7] as number)
      let pz = (m[9] as number) * y + (m[10] as number) * z + (m[11] as number)
      for (let x = 0; x < tx; x++, i++) {
        const a = Math.round(px)
        const b = Math.round(py)
        const c = Math.round(pz)
        if (a >= 0 && a < fx && b >= 0 && b < fy && c >= 0 && c < fz)
          out[i] = label[(c * fy + b) * fx + a] as number
        px += m[0] as number
        py += m[4] as number
        pz += m[8] as number
      }
    }
  return out
}
