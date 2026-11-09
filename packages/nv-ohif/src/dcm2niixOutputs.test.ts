import { describe, expect, it } from 'bun:test'
import type { OutputFile, Series } from '@niivue/dcm2niix'
import { niftiVoxels, outputEcho, rankOutputs } from './dcm2niixOutputs'

// A NIfTI-1 header (352 bytes) with the given dims; no voxel data.
function niftiFile(name: string, dims: number[], le = true): OutputFile {
  const view = new DataView(new ArrayBuffer(352))
  view.setInt32(0, 348, le)
  view.setInt16(40, dims.length, le)
  for (const [i, d] of dims.entries()) view.setInt16(42 + 2 * i, d, le)
  return Object.assign(new File([view.buffer], name), { relativePath: name })
}

function series(
  stem: string,
  dims: number[],
  json?: Record<string, unknown>,
): Series {
  return { stem, image: niftiFile(`${stem}.nii`, dims), json }
}

const primary = { ImageType: ['ORIGINAL', 'PRIMARY', 'M', 'ND'] }
const stems = async (list: Series[]) =>
  (await rankOutputs(list)).map((s) => s.stem)

describe('niftiVoxels', () => {
  it('reads either byte order', async () => {
    expect(await niftiVoxels(niftiFile('a.nii', [4, 5, 6]))).toBe(120)
    expect(await niftiVoxels(niftiFile('a.nii', [4, 5, 6, 2], false))).toBe(240)
  })

  it('is 0 for a non-NIfTI-1 header', async () => {
    expect(await niftiVoxels(new File([new Uint8Array(400)], 'a.nii'))).toBe(0)
    expect(await niftiVoxels(new File(['short'], 'a.nii'))).toBe(0)
  })
})

describe('outputEcho', () => {
  it('reads the sidecar, else the _e<N> stem; undefined for single echo', () => {
    expect(outputEcho(series('t_e2', [1], { EchoNumber: 2 }))).toBe(2)
    expect(outputEcho(series('t_e1', [1], primary))).toBe(1)
    expect(outputEcho(series('t', [1], primary))).toBeUndefined()
  })
})

describe('rankOutputs (owner Q5)', () => {
  it.each([
    [
      'ORIGINAL/PRIMARY beats a larger derived image',
      [
        series('mpr', [64, 64, 64], { ImageType: ['DERIVED', 'SECONDARY'] }),
        series('t1', [8, 8, 8], primary),
      ],
      ['t1', 'mpr'],
    ],
    [
      'magnitude beats phase/real/imaginary by sidecar ImageType',
      [
        series('fl_ph', [9, 9, 9], { ImageType: ['ORIGINAL', 'PRIMARY', 'P'] }),
        series('fl_imaginary', [9, 9, 9], {
          ImageType: ['ORIGINAL', 'PRIMARY', 'IMAGINARY'],
        }),
        series('fl_real', [9, 9, 9], {
          ImageType: ['ORIGINAL', 'PRIMARY', 'REAL'],
        }),
        series('fl', [8, 8, 8], primary),
      ],
      ['fl', 'fl_imaginary', 'fl_ph', 'fl_real'],
    ],
    [
      'magnitude beats the R and I parts dcm2niix writes in ImageType',
      [
        series('scan_R', [9, 9, 9], {
          ImageType: ['ORIGINAL', 'PRIMARY', 'R'],
        }),
        series('scan_I', [9, 9, 9], {
          ImageType: ['ORIGINAL', 'PRIMARY', 'I'],
        }),
        series('scan_M', [9, 9, 9], {
          ImageType: ['ORIGINAL', 'PRIMARY', 'M'],
        }),
      ],
      ['scan_M', 'scan_I', 'scan_R'],
    ],
    [
      'a protocol named *_ph_* is not a phase part when the sidecar says M',
      [series('swi_ph_a', [8, 8, 8], primary), series('swi_ph', [9, 9, 9])],
      ['swi_ph_a', 'swi_ph'],
    ],
    [
      'no sidecar: base stem beats a _ph part',
      [series('fl_ph', [9, 9, 9]), series('fl', [8, 8, 8])],
      ['fl', 'fl_ph'],
    ],
    [
      'lowest echo, missing EchoNumber counts as 1',
      [
        series('me_e2', [9, 9, 9], { ...primary, EchoNumber: 2 }),
        series('me_e1', [8, 8, 8], { ...primary, EchoNumber: 1 }),
        series('se', [7, 7, 7], primary),
      ],
      ['me_e1', 'se', 'me_e2'],
    ],
    [
      'no sidecar: echo from the _e<N> stem',
      [series('me_e2', [9, 9, 9]), series('me', [8, 8, 8])],
      ['me', 'me_e2'],
    ],
    [
      'most voxels, then stem; _Tilt/_Eq get no preference',
      [
        series('ct_Tilt_1', [8, 8, 8], primary),
        series('ct', [8, 8, 9], primary),
        series('ct_Eq_1', [8, 8, 8], primary),
      ],
      ['ct', 'ct_Eq_1', 'ct_Tilt_1'],
    ],
  ])('%s', async (_name, list, expected) => {
    expect(await stems(list)).toEqual(expected)
  })

  it('keeps NIfTI images only', async () => {
    const nrrd: Series = {
      stem: 'x',
      image: Object.assign(new File([''], 'x.nrrd'), {
        relativePath: 'x.nrrd',
      }),
    }
    expect(await stems([nrrd, series('a', [2, 2, 2])])).toEqual(['a'])
  })
})
