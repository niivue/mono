import type { RasGrid } from './quantify'

// OHIF's 4D (cornerstone-dynamic-volume) computations on a NiiVue frame source:
// computed volumes over a frame range and per-segment time-activity curves.
// Frames are raw native-order values; scaling is applied outside the loops.

export type ComputeOp = 'SUM' | 'AVERAGE' | 'SUBTRACT'

export interface Frames {
  count: number
  load: (frame: number) => Promise<ArrayLike<number>>
}

/**
 * cornerstone's generateImageFromTimeData over 1-based frames `start`..`end`:
 * SUM, AVERAGE, or SUBTRACT (start - end), scaled. Native voxel order.
 */
export async function computeVolume(
  op: ComputeOp,
  frames: Frames,
  start: number,
  end: number,
  slope: number,
  inter: number,
): Promise<Float32Array> {
  if (end <= start) throw new Error('Please provide two or more frames')
  const first = await frames.load(start - 1)
  const n = first.length
  const out = new Float32Array(n)
  if (op === 'SUBTRACT') {
    const last = await frames.load(end - 1)
    for (let i = 0; i < n; i++)
      out[i] = ((first[i] as number) - (last[i] as number)) * slope
    return out
  }
  out.set(first)
  for (let f = start; f < end; f++) {
    const d = await frames.load(f)
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (d[i] as number)
  }
  const k = end - start + 1
  // SUM of scaled frames = slope * raw sum + k * inter; AVERAGE divides by k.
  const [s, b] = op === 'SUM' ? [slope, k * inter] : [slope / k, inter]
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * s + b
  return out
}

export interface Curve {
  /** Label value (OHIF: one segmentation per curve). */
  value: number
  count: number
  mean: number[]
  std: number[]
  min: number[]
  max: number[]
  /** Native indices of the label's voxels and their RAS voxel coordinates. */
  voxels: Int32Array
  ras: Int32Array
}

/**
 * Per-frame mean, population std, min and max of each label's voxels (cornerstone's
 * getDataInTime over a mask, as OHIF's chart and CSV summarise it).
 */
export async function timeActivity(
  label: Uint8Array,
  grid: RasGrid,
  frames: Frames,
  slope: number,
  inter: number,
): Promise<Curve[]> {
  const [nx, ny, nz] = grid.dims
  const [sx, sy, sz] = grid.step
  // Counting sort of the labelled voxels by value: one pass, then per-frame
  // loops touch only labelled voxels.
  const counts = new Int32Array(256)
  for (let i = 0; i < label.length; i++) {
    const v = label[i] as number
    counts[v] = (counts[v] as number) + 1
  }
  const offset = new Int32Array(257)
  for (let v = 1; v < 256; v++)
    offset[v + 1] = (offset[v] as number) + (counts[v] as number)
  const total = offset[256] as number
  const voxels = new Int32Array(total)
  const ras = new Int32Array(total * 3)
  const fill = offset.slice()
  let i = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const row = grid.start + y * sy + z * sz
      for (let x = 0; x < nx; x++, i++) {
        const v = label[i] as number
        if (!v) continue
        const k = (fill[v] as number)++
        voxels[k] = row + x * sx
        ras[3 * k] = x
        ras[3 * k + 1] = y
        ras[3 * k + 2] = z
      }
    }
  const curves: Curve[] = []
  for (let v = 1; v < 256; v++)
    if (counts[v])
      curves.push({
        value: v,
        count: counts[v] as number,
        mean: [],
        std: [],
        min: [],
        max: [],
        voxels: voxels.subarray(offset[v], offset[v + 1]),
        ras: ras.subarray(
          3 * (offset[v] as number),
          3 * (offset[v + 1] as number),
        ),
      })
  const flip = slope < 0
  const acc = new Float64Array(4)
  for (let f = 0; f < frames.count; f++) {
    const d = await frames.load(f)
    for (const c of curves) {
      voxelSums(d, c.voxels, acc)
      const [sum = 0, sq = 0, lo = 0, hi = 0] = acc
      const m = sum / c.count
      c.mean.push(m * slope + inter)
      c.std.push(Math.sqrt(Math.max(0, sq / c.count - m * m)) * Math.abs(slope))
      c.min.push((flip ? hi : lo) * slope + inter)
      c.max.push((flip ? lo : hi) * slope + inter)
    }
  }
  return curves
}

/** Sum, sum of squares, min and max of `d` at `voxels`, into `acc`. */
function voxelSums(
  d: ArrayLike<number>,
  voxels: Int32Array,
  acc: Float64Array,
) {
  let sum = 0
  let sq = 0
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let k = 0; k < voxels.length; k++) {
    const r = d[voxels[k] as number] as number
    sum += r
    sq += r * r
    if (r < lo) lo = r
    if (r > hi) hi = r
  }
  acc[0] = sum
  acc[1] = sq
  acc[2] = lo
  acc[3] = hi
}

/**
 * OHIF's chart time axis: the sorted distinct FrameReferenceTime (ms), rescaled
 * to s/m/h while more than half the points exceed the next unit.
 */
export function timePoints(instances: ReadonlyArray<Record<string, unknown>>): {
  points: number[]
  unit: string
} {
  let points = [
    ...new Set(
      instances
        .map((i) => i.FrameReferenceTime)
        .filter((t) => t !== undefined)
        .map(Number),
    ),
  ].sort((a, b) => a - b)
  const units = ['ms', 's', 'm', 'h']
  const divisors = [1000, 60, 60]
  let unit = 'ms'
  let divisor = 1
  for (let u = 0; u < divisors.length; u++) {
    const next = divisor * (divisors[u] as number)
    if (points.filter((t) => t > next).length <= points.length / 2) break
    divisor = next
    unit = units[u + 1] as string
  }
  if (divisor > 1) points = points.map((t) => t / divisor)
  return { points, unit }
}

/** OHIF's exportTimeReportCSV: per-voxel Time Data, or the ROI Stats summary. */
export function timeReportCsv(
  study: Record<string, unknown>,
  curves: ReadonlyArray<Curve & { label: string }>,
  summary: boolean,
  frames: number,
  values?: (c: Curve, voxel: number) => number[],
): string {
  const csv = [
    `Patient ID,${study.PatientID},`,
    `Study Date,${study.StudyDate},`,
    `StudyInstanceUID,${study.StudyInstanceUID},`,
    `StudyDescription,${study.StudyDescription},`,
    `SeriesInstanceUID,${study.SeriesInstanceUID},`,
    '',
    '',
  ]
  const times = Array.from(
    { length: frames },
    (_, t) => `,Time Point ${t}`,
  ).join('')
  for (const c of curves) {
    if (summary) {
      csv.push(`Operation,Segmentation Label ID${times}`)
      csv.push(`Mean,${c.label},${c.mean.join(',')}`)
      csv.push(`Standard Deviation,${c.label},${c.std.join(',')}`)
      csv.push(`Min,${c.label},${c.min.join(',')}`)
      csv.push(`Max,${c.label},${c.max.join(',')}`)
      continue
    }
    csv.push(`Pixel Identifier (IJK),Segmentation Label ID${times}`)
    for (let k = 0; k < c.count; k++) {
      const ijk = `${c.ras[3 * k]}_${c.ras[3 * k + 1]}_${c.ras[3 * k + 2]}`
      csv.push(`${ijk},${c.label},${values?.(c, k).join(',') ?? ''}`)
    }
  }
  return csv.join('\n')
}

/** Every voxel's scaled value per frame, for the Time Data CSV (all frames held at once). */
export async function voxelSeries(
  frames: Frames,
  slope: number,
  inter: number,
): Promise<(c: Curve, voxel: number) => number[]> {
  const data: ArrayLike<number>[] = []
  for (let f = 0; f < frames.count; f++) data.push(await frames.load(f))
  return (c, k) =>
    data.map((d) => (d[c.voxels[k] as number] as number) * slope + inter)
}
