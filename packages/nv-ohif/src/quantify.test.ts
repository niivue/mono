import { describe, expect, it } from 'bun:test'
import {
  boxAround,
  boxMax,
  ijkAxes,
  type RasGrid,
  resampleLabel,
  type Sampled,
  segmentStats,
  slabCorners,
  thresholdBox,
} from './quantify'

// 3x2x2 RAS voxels, 2x2x3 mm; native x runs R->L (start 2, step -1), so a
// RAS/native mix-up moves voxels. Raw value = native index; scaled = 2r + 1.
const pet: RasGrid = {
  dims: [3, 2, 2],
  start: 2,
  step: [-1, 3, 6],
  affine: [2, 0, 0, 10, 0, 2, 0, 0, 0, 0, 3, 0],
}
const pt: Sampled = {
  data: Int16Array.from({ length: 12 }, (_, i) => i),
  grid: pet,
  slope: 2,
  inter: 1,
}
// Rectangle over RAS x 0..1, y 0..1, at z = 0 mm; slab to z = 6 mm takes slices 0 and 3 mm.
const rect = [
  [10, 0, 0],
  [12, 0, 0],
  [12, 2, 0],
  [10, 2, 0],
]
const box = boxAround(slabCorners(rect, 2, 0, 6, 3), pet)

describe('ROI threshold (cornerstone semantics)', () => {
  it('Max% thresholds weight x box max, clearing only its own value', () => {
    expect(box).toEqual([0, 1, 0, 1, 0, 1])
    expect(boxMax(pt, box)).toBe(23) // native 11 at RAS (0,1,1)
    const label = new Uint8Array(12)
    label[0] = 2
    label[11] = 1
    // > 11.5 keeps native 7, 8, 10, 11: the z = 1 slice of the box.
    expect(thresholdBox(label, pt, box, 0.5 * 23, Infinity, 1)).toBe(4)
    expect([...label]).toEqual([2, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0])
  })

  it('Range excludes values equal to its bounds', () => {
    const label = new Uint8Array(12)
    // 15 is native 7 exactly: out, as cornerstone's strict test.
    expect(thresholdBox(label, pt, box, 15, 100, 1)).toBe(3)
    expect(label[7]).toBe(0)
  })

  it('needs an in-range CT voxel overlapping the PT voxel', () => {
    // CT 1 mm in x (centres 9.5 + i): PT x = 0 overlaps CT 0..2, x = 1 CT 2..4.
    const ct: Sampled = {
      data: new Int16Array(24).fill(-2000),
      grid: {
        dims: [6, 2, 2],
        start: 0,
        step: [1, 6, 12],
        affine: [1, 0, 0, 9.5, 0, 2, 0, 0, 0, 0, 3, 0],
      },
      slope: 1,
      inter: 0,
    }
    ;(ct.data as Int16Array)[0] = 0
    const label = new Uint8Array(12)
    const all = boxAround(
      [
        [0, 0, 0],
        [99, 99, 99],
      ],
      pet,
    )
    expect(
      thresholdBox(label, pt, all, -1e9, 1e9, 1, {
        ct,
        lower: -1024,
        upper: 1024,
      }),
    ).toBe(1)
    expect(label[0]).toBe(1)
  })

  // Audit 22.4: CT x runs backwards (RAS 3 = native 2, the only in-range
  // voxel). The PT voxel spans CT RAS 3.5..5.5, native -0.5..1.5: cornerstone
  // rounds natively to 0..2 (getVoxelOverlap) and reaches it.
  it('rounds CT overlap ends in the CT index order on a flipped axis', () => {
    const flipped = (n: number, dx: number, x0: number, data: number[]) => ({
      data: Int16Array.from(data),
      grid: {
        dims: [n, 1, 1] as RasGrid['dims'],
        start: n - 1,
        step: [-1, n, n] as RasGrid['step'],
        affine: [dx, 0, 0, x0, 0, 1, 0, 0, 0, 0, 1, 0],
      },
      slope: 1,
      inter: 0,
    })
    const pt1 = flipped(3, 2, 6, [5, 5, 5])
    const ct = flipped(6, 1, 5.5, [-2000, -2000, 0, -2000, -2000, -2000])
    const label = new Uint8Array(3)
    const range = { ct, lower: -1024, upper: 1024 }
    expect(
      thresholdBox(label, pt1, [2, 2, 0, 0, 0, 0], 2.5, 50, 1, range),
    ).toBe(1)
    // Axial DICOM rows run toward patient left, columns posterior: both RAS-reversed.
    expect(ijkAxes(ct.grid, [1, 0, 0, 0, 1, 0])).toEqual({
      axis: [0, 1, 2],
      dir: [-1, -1, 1],
    })
  })
})

it('segment stats: volume, mean, glycolysis, SUVpeak', () => {
  const label = new Uint8Array(12)
  for (const i of [6, 7, 9, 10]) label[i] = 1
  const s = segmentStats(label, pt, 1)
  // Native 8, 7, 11, 10 -> 17, 15, 23, 21.
  expect(s).toMatchObject({ count: 4, volume: 48, mean: 19, max: 23, min: 15 })
  expect(s?.lesionGlycolysis).toBe(48 * 19)
  // 1 mL sphere radius (3, 3, 2) voxels covers the grid: the volume mean.
  expect(s?.peak).toBe(12)
  // 8 mm voxels: radius 1, centre + face neighbours. Hottest native 11 with
  // 10, 8, 5 -> mean 8.5 -> 18; the other candidates are lower.
  const coarse = { ...pet, affine: [8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 0] }
  expect(segmentStats(label, { ...pt, grid: coarse }, 1)?.peak).toBe(18)
})

// Audit 22.5: of 11 tied maxima cornerstone's calculator keeps the last ten
// in its index order (native x = 2..23), so the plateau at native 23
// (neighbours 8) sets the peak, 26/3. RAS x runs backwards, so RAS-order
// traversal or the earliest ties would miss it.
it('SUVpeak keeps the later of more than ten tied maxima', () => {
  const data = new Float32Array(25)
  const label = new Uint8Array(25)
  for (const x of [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 23]) {
    data[x] = 10
    label[24 - x] = 1
  }
  data[22] = data[24] = 8
  const grid: RasGrid = {
    dims: [25, 1, 1],
    start: 24,
    step: [-1, 25, 25],
    affine: [8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 0],
  }
  const s = segmentStats(label, { data, grid, slope: 1, inter: 0 }, 1)
  expect(s?.peak).toBeCloseTo(26 / 3, 10)
})

it('resamples labels to a finer grid and back by nearest voxel', () => {
  const ct: RasGrid = {
    dims: [6, 2, 2],
    start: 0,
    step: [1, 6, 12],
    affine: [1, 0, 0, 9.5, 0, 2, 0, 0, 0, 0, 3, 0],
  }
  const label = Uint8Array.from({ length: 12 }, (_, i) => i + 1)
  const fine = resampleLabel(label, pet, ct)
  expect([...fine.subarray(0, 6)]).toEqual([1, 1, 2, 2, 3, 3])
  expect([...resampleLabel(fine, ct, pet)]).toEqual([...label])
})
