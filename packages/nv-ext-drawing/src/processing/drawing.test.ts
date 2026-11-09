import { describe, expect, test } from 'bun:test'
import {
  type InterpolationOptions,
  interpolateMaskSlices,
  type RASIndexMap,
  SLICE_TYPE,
  type SliceType,
} from './drawing'

// Non-cubic so a swapped axis cannot pass by accident.
const dims = { dimX: 20, dimY: 18, dimZ: 16 }
const nVox = dims.dimX * dims.dimY * dims.dimZ

// Header order flips x and z relative to RAS.
const flipXZ: RASIndexMap = {
  img2RASstep: [-1, dims.dimX, -dims.dimX * dims.dimY],
  img2RASstart: [dims.dimX - 1, 0, (dims.dimZ - 1) * dims.dimX * dims.dimY],
}

/** Two colors drawn as offset discs on two slices each along `sliceType`. */
function drawing(sliceType: SliceType): Uint8Array {
  const bmp = new Uint8Array(nVox)
  const set = (a: number, b: number, s: number, c: number) => {
    const [x, y, z] =
      sliceType === SLICE_TYPE.AXIAL
        ? [a, b, s]
        : sliceType === SLICE_TYPE.CORONAL
          ? [a, s, b]
          : [s, a, b]
    bmp[x + y * dims.dimX + z * dims.dimX * dims.dimY] = c
  }
  const disc = (s: number, cx: number, cy: number, r: number, c: number) => {
    for (let b = 0; b < 16; b++)
      for (let a = 0; a < 16; a++)
        if ((a - cx) ** 2 + (b - cy) ** 2 < r * r) set(a, b, s, c)
  }
  disc(1, 5, 6, 3.5, 1)
  disc(9, 8, 7, 4.5, 1)
  disc(3, 11, 10, 2.5, 2)
  disc(8, 10, 9, 3.5, 2)
  return bmp
}

// Smooth gradient plus a bright blob so guidance changes some voxels.
const image = new Float32Array(nVox)
for (let i = 0; i < nVox; i++)
  image[i] = 40 + (i % 7) * 3 + (i % 113 < 20 ? 60 : 0)

function checksum(bmp: Uint8Array): number {
  let h = 2166136261
  for (let i = 0; i < bmp.length; i++)
    if (bmp[i]) h = Math.imul(h ^ (i * 3 + bmp[i]), 16777619) >>> 0
  return h
}

function run(
  sliceType: SliceType,
  opts: InterpolationOptions,
  img: Float32Array | null = null,
  rasMap?: RASIndexMap,
  lo?: number,
  hi?: number,
): Uint8Array {
  return interpolateMaskSlices(
    drawing(sliceType),
    dims,
    img,
    100,
    lo,
    hi,
    { sliceType, ...opts },
    rasMap,
  )
}

const names = ['axial', 'coronal', 'sagittal'] as const

describe('interpolateMaskSlices', () => {
  test('fills intermediate slices for each color', () => {
    const out = run(SLICE_TYPE.AXIAL, {})
    const slice = dims.dimX * dims.dimY
    for (const [color, z] of [
      [1, 5],
      [2, 5],
    ]) {
      const s = out.subarray(z * slice, (z + 1) * slice)
      expect(s.includes(color)).toBe(true)
    }
  })

  test('guided without intensity data falls back to unguided', () => {
    for (const st of [0, 1, 2] as SliceType[])
      expect(run(st, { useIntensityGuided: true })).toEqual(run(st, {}))
  })

  // Pinned to the output of the original implementation (fb518085).
  test('matches reference output', () => {
    const got: Record<string, number> = {}
    for (const st of [0, 1, 2] as SliceType[]) {
      const n = names[st]
      got[`${n} unguided`] = checksum(run(st, {}))
      got[`${n} unsmoothed`] = checksum(
        run(st, { applySmoothingToSlices: false }),
      )
      got[`${n} guided`] = checksum(
        run(st, { useIntensityGuided: true }, image),
      )
      got[`${n} guided ras`] = checksum(
        run(st, { useIntensityGuided: true }, image, flipXZ),
      )
      got[`${n} guided restricted`] = checksum(
        run(st, { useIntensityGuided: true }, image, flipXZ, 2, 7),
      )
    }
    expect(got).toMatchInlineSnapshot(`
      {
        "axial guided": 4078824591,
        "axial guided ras": 23404717,
        "axial guided restricted": 3190351789,
        "axial unguided": 1348400201,
        "axial unsmoothed": 3342346752,
        "coronal guided": 2325342192,
        "coronal guided ras": 3160502639,
        "coronal guided restricted": 588317931,
        "coronal unguided": 318641223,
        "coronal unsmoothed": 2519879710,
        "sagittal guided": 2347390455,
        "sagittal guided ras": 2400867169,
        "sagittal guided restricted": 1630419630,
        "sagittal unguided": 2939267550,
        "sagittal unsmoothed": 81558678,
      }
    `)
  })
})
