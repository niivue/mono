import { describe, expect, test } from 'bun:test'
import type { NVImage, NVMesh, NVMeshLayer } from '@/NVTypes'
import {
  computeMeshLabelCentroids,
  meshLabelCentroid,
  volumeLabelCentroid,
} from '@/view/legendCentroids'
import { computeVolumeLabelCentroids } from './utils'

const [nx, ny, nz] = [5, 4, 3]
const matRAS = [
  0.9, 0.1, 0, -10, 0, 1.1, -0.2, -12, 0.05, 0, 1.2, -9, 0, 0, 0, 1,
]
const mm = (r: number[]): [number, number, number] =>
  [0, 1, 2].map(
    (a) =>
      matRAS[4 * a] * r[0] +
      matRAS[4 * a + 1] * r[1] +
      matRAS[4 * a + 2] * r[2] +
      matRAS[4 * a + 3],
  ) as [number, number, number]

// RAS voxel -> native index for a volume stored flipped in x with y and z swapped.
const start = [nx - 1, 0, 0]
const step = [-1, nx * nz, nx]
const native = (rx: number, ry: number, rz: number) =>
  start[0] + rx * step[0] + ry * step[1] + rz * step[2]

function volume(
  img: ArrayLike<number>,
  labels: string[],
  hdr: Partial<NVImage['hdr']> = {},
): NVImage {
  return {
    img,
    dimsRAS: [3, nx, ny, nz],
    nVox3D: nx * ny * nz,
    img2RASstart: start,
    img2RASstep: step,
    matRAS,
    hdr: {
      scl_slope: 1,
      scl_inter: 0,
      intent_code: 0,
      datatypeCode: 2,
      ...hdr,
    },
    colormapLabel: {
      lut: new Uint8ClampedArray(4 * labels.length),
      min: 0,
      max: labels.length - 1,
      labels,
    },
  } as unknown as NVImage
}

/** Brute force: mean of every voxel's mm position, weighted, pooled by name. */
function reference(
  sample: (rx: number, ry: number, rz: number) => [string, number][],
) {
  const sums: Record<string, number[]> = {}
  for (let rz = 0; rz < nz; rz++)
    for (let ry = 0; ry < ny; ry++)
      for (let rx = 0; rx < nx; rx++)
        for (const [name, w] of sample(rx, ry, rz)) {
          const p = mm([rx, ry, rz])
          sums[name] ??= [0, 0, 0, 0]
          for (let c = 0; c < 3; c++) sums[name][c] += p[c] * w
          sums[name][3] += w
        }
  return Object.fromEntries(
    Object.entries(sums).map(([k, s]) => [
      k,
      [s[0] / s[3], s[1] / s[3], s[2] / s[3]],
    ]),
  )
}

function expectClose(
  got: Record<string, number[]>,
  want: Record<string, number[]>,
) {
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort())
  for (const k of Object.keys(want))
    for (let c = 0; c < 3; c++) expect(got[k][c]).toBeCloseTo(want[k][c], 9)
}

describe('computeVolumeLabelCentroids', () => {
  const labels = ['bg', 'a', 'dup', 'dup', '']
  const labelAt = (rx: number, ry: number, rz: number) =>
    (rx * 3 + ry * 2 + rz * 5) % 7 // 4 is unnamed; 5 and 6 are past the LUT

  test('scaled scalar labels: reoriented, pooled by name, out-of-range and unnamed skipped', () => {
    const img = new Float32Array(nx * ny * nz)
    for (let rz = 0; rz < nz; rz++)
      for (let ry = 0; ry < ny; ry++)
        for (let rx = 0; rx < nx; rx++)
          img[native(rx, ry, rz)] = (labelAt(rx, ry, rz) - 1) / 0.5
    const want = reference((rx, ry, rz) => {
      const name = labels[labelAt(rx, ry, rz)]
      return name ? [[name, 1]] : []
    })
    expectClose(
      computeVolumeLabelCentroids(
        volume(img, labels, { scl_slope: 0.5, scl_inter: 1, datatypeCode: 16 }),
      ),
      want,
    )
  })

  test('PAQD: two regions per voxel, weighted by probability', () => {
    const img = new Uint8Array(4 * nx * ny * nz)
    const at = (rx: number, ry: number, rz: number) => {
      const l = labelAt(rx, ry, rz)
      return [l, (l + 2) % 7, (rx * 37) % 256, (rz * 91 + ry) % 256]
    }
    for (let rz = 0; rz < nz; rz++)
      for (let ry = 0; ry < ny; ry++)
        for (let rx = 0; rx < nx; rx++)
          img.set(at(rx, ry, rz), 4 * native(rx, ry, rz))
    const want = reference((rx, ry, rz) => {
      const [i1, i2, w1, w2] = at(rx, ry, rz)
      return (
        [
          [labels[i1], w1],
          [labels[i2], w2],
        ] as [string, number][]
      ).filter(([n, w]) => n && w)
    })
    expectClose(
      computeVolumeLabelCentroids(
        volume(img, labels, { intent_code: 1002, datatypeCode: 2304 }),
      ),
      want,
    )
  })
})

describe('legend centroids', () => {
  test('computed on demand, cached, and recomputed when the voxels are replaced', () => {
    const img = new Uint8Array(nx * ny * nz)
    img[native(1, 1, 1)] = 1
    // Like addVolume({ colormapLabel }): nothing precomputed on the LUT.
    const vol = volume(img, ['bg', 'a'])
    const first = volumeLabelCentroid(vol, 'a')
    expect(first).toEqual(mm([1, 1, 1]))
    expect(volumeLabelCentroid(vol, 'a')).toBe(first) // cached: same array
    const moved = new Uint8Array(nx * ny * nz)
    moved[native(3, 2, 0)] = 1
    vol.img = moved
    const second = volumeLabelCentroid(vol, 'a')
    expect(second).toEqual(mm([3, 2, 0]))
    vol.colormapLabel = { lut: new Uint8ClampedArray(8), labels: ['bg', 'a'] }
    expect(volumeLabelCentroid(vol, 'a')).not.toBe(second) // new LUT: recomputed
  })

  test('recomputed when the affine changes (applyVolumeTransform assigns a new matRAS)', () => {
    const img = new Uint8Array(nx * ny * nz)
    img[native(1, 1, 1)] = 1
    const vol = volume(img, ['bg', 'a'])
    expect(volumeLabelCentroid(vol, 'a')).toEqual(mm([1, 1, 1]))
    const shifted = matRAS.slice()
    shifted[3] += 50
    vol.matRAS = shifted as unknown as NVImage['matRAS']
    const want = mm([1, 1, 1])
    want[0] += 50
    expect(volumeLabelCentroid(vol, 'a')).toEqual(want)
  })

  test('mesh layers: vertex positions averaged per name, cached on the values array', () => {
    const positions = new Float32Array([0, 0, 0, 2, 4, 6, 10, 10, 10, 1, 1, 1])
    const layer = {
      values: new Float32Array([1, 1, 2, Number.NaN]),
      colormapLabel: {
        lut: new Uint8ClampedArray(12),
        min: 0,
        max: 2,
        labels: ['bg', 'a', 'b'],
      },
    } as unknown as NVMeshLayer
    expect(computeMeshLabelCentroids(positions, layer)).toEqual({
      a: [1, 2, 3],
      b: [10, 10, 10],
    })
    const mesh = { positions } as unknown as NVMesh
    const a = meshLabelCentroid(mesh, layer, 'a')
    expect(a).toEqual([1, 2, 3])
    expect(meshLabelCentroid(mesh, layer, 'a')).toBe(a)
  })
})
