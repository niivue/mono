import { expect, test } from 'bun:test'
import { dicomWindow, unitForDisplaySet } from './commands'
import { floorSuvWindow, scaleNifti, suvBwFactor } from './suv'

// OHIF D6 (TMTV) PET AC: 91 kg, 588.8 MBq FDG at 07:21, series 09:59:47.
const pet = {
  Units: 'BQML',
  CorrectedImage: ['DECY', 'ATTN', 'SCAT'],
  DecayCorrection: 'START',
  PatientWeight: 91,
  SeriesDate: '19600116',
  SeriesTime: '095947.00',
  RadiopharmaceuticalInformationSequence: [
    {
      RadiopharmaceuticalStartTime: '072100.00',
      RadionuclideTotalDose: 588802304,
      RadionuclideHalfLife: 6588,
    },
  ],
}

test('SUVbw factor decays the dose to the series start', () => {
  const decayed = 588802304 * 2 ** (-(2 * 3600 + 38 * 60 + 47) / 6588)
  expect(suvBwFactor(pet)).toBeCloseTo(91000 / decayed, 12)
})

test('decay runs to the earliest acquisition when the series time is later', () => {
  // Reconstructed 1 h after acquisition: SeriesTime 10:59:47, acquired 09:59:47.
  const recon = (t: string) => ({
    ...pet,
    SeriesTime: '105947.00',
    AcquisitionTime: t,
  })
  expect(suvBwFactor(recon('095947'), [recon('100500'), recon('095947')])).toBe(
    suvBwFactor(pet),
  )
})

test('a series not attenuation and decay corrected stays in Bq/ml', () => {
  expect(suvBwFactor({ ...pet, CorrectedImage: 'DECY' })).toBeUndefined()
  expect(suvBwFactor({ ...pet, CorrectedImage: undefined })).toBeUndefined()
})

test('scaleNifti multiplies slope and intercept, treating slope 0 as 1', async () => {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  hdr.setFloat32(116, -2, true)
  const out = new DataView(
    await (
      await scaleNifti(new File([hdr.buffer], 'x.nii'), 0.5)
    ).arrayBuffer(),
  )
  expect(out.getFloat32(112, true)).toBe(0.5)
  expect(out.getFloat32(116, true)).toBe(-1)
  expect(out.byteLength).toBe(352)
})

test('a time-only injection before midnight declines conversion', () => {
  // 23:30 injection, 00:30 scan the next day: reads as 23 h in the future.
  const late = {
    ...pet,
    SeriesDate: '20261117',
    SeriesTime: '003000',
    RadiopharmaceuticalInformationSequence: [
      {
        ...pet.RadiopharmaceuticalInformationSequence[0],
        RadiopharmaceuticalStartTime: '233000',
      },
    ],
  }
  expect(suvBwFactor(late)).toBeUndefined()
  // An explicit injection datetime resolves it.
  const dated = {
    ...late,
    RadiopharmaceuticalInformationSequence: [
      {
        ...late.RadiopharmaceuticalInformationSequence[0],
        RadiopharmaceuticalStartDateTime: '20261116233000',
      },
    ],
  }
  expect(suvBwFactor(dated)).toBeGreaterThan(0)
})

test('PT unit and DICOM window follow whether SUV was applied', () => {
  const ds = (inst: Record<string, unknown>) => ({
    Modality: 'PT',
    instances: [inst],
  })
  expect(unitForDisplaySet(ds(pet))).toBe('SUV')
  expect(unitForDisplaySet(ds({ ...pet, DecayCorrection: 'NONE' }))).toBe(
    'Bq/ml',
  )
  expect(unitForDisplaySet(ds({ ...pet, Units: 'CNTS' }))).toBe('CNTS')
  const w = dicomWindow(ds({ ...pet, WindowWidth: 14000, WindowCenter: 7000 }))
  const f = suvBwFactor(pet) as number
  expect(w?.calMax).toBeCloseTo(14000 * f, 9)
  expect(
    dicomWindow(
      ds({ ...pet, Units: 'CNTS', WindowWidth: 14000, WindowCenter: 7000 }),
    )?.calMax,
  ).toBe(14000)
})

test('an SUV window dragged below 0 is floored at 0, other units are not', () => {
  const calls: unknown[] = []
  const nv = Object.assign(new EventTarget(), {
    setVolume: async (i: number, o: object) => void calls.push([i, o]),
  })
  let suv = true
  floorSuvWindow(nv as never, () => suv)
  const drag = (calMin: number, calMax: number) =>
    nv.dispatchEvent(
      new CustomEvent('volumeUpdated', {
        detail: { volumeIndex: 0, volume: { calMin, calMax } },
      }),
    )
  drag(-1.5, 3.5)
  drag(-2, -0.5)
  drag(0.5, 3)
  suv = false
  drag(-1, 4)
  expect(calls).toEqual([
    [0, { calMin: 0, calMax: 3.5 }],
    [0, { calMin: 0, calMax: 0.1 }],
  ])
})
