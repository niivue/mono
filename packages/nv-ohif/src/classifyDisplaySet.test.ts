import { describe, expect, it } from 'bun:test'
import {
  classifyDisplaySet,
  extraDisplaySetsNote,
  type NiivueLoadKind,
} from './classifyDisplaySet'

const wadorsId = (sop: string) =>
  `wadors:https://host/dicomweb/studies/1.2/series/3.4/instances/${sop}/frames/1`

describe('classifyDisplaySet', () => {
  it('routes a NIfTI-URL display set to nifti', () => {
    expect(classifyDisplaySet({ url: 'https://x/mni152.nii.gz' })).toBe('nifti')
    expect(
      classifyDisplaySet({ instances: [{ url: 'https://x/a.nrrd' }] }),
    ).toBe('nifti')
  })

  it('routes a volumetric DICOMweb series to dicom-volume', () => {
    expect(
      classifyDisplaySet({
        Modality: 'CT',
        instances: [{ imageId: wadorsId('5.1') }, { imageId: wadorsId('5.2') }],
      }),
    ).toBe('dicom-volume')
  })

  it('routes a whole-slide (SM) DICOMweb series to wsi', () => {
    expect(
      classifyDisplaySet({
        Modality: 'SM',
        instances: [{ imageId: wadorsId('9.1') }],
      }),
    ).toBe('wsi')
  })

  it('routes a relative DICOMweb root (OHIF wadoRoot "/dicomweb")', () => {
    const relId = (sop: string) =>
      `wadors:/dicomweb/studies/1.2/series/3.4/instances/${sop}/frames/1`
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://host/viewer/niivue' },
      configurable: true,
    })
    try {
      expect(
        classifyDisplaySet({
          Modality: 'CT',
          instances: [{ imageId: relId('5.1') }],
        }),
      ).toBe('dicom-volume')
      expect(
        classifyDisplaySet({
          Modality: 'SM',
          instances: [{ imageId: relId('9.1') }],
        }),
      ).toBe('wsi')
    } finally {
      Reflect.deleteProperty(globalThis, 'location')
    }
  })

  it('returns unsupported when there is nothing loadable', () => {
    expect(classifyDisplaySet({ Modality: 'CT' })).toBe('unsupported')
    expect(classifyDisplaySet({ instances: [{ SOPInstanceUID: '5.1' }] })).toBe(
      'unsupported',
    )
  })

  it.each([
    ['SEG', 'unsupported'],
    ['RTSTRUCT', 'unsupported'],
    ['RTPLAN', 'unsupported'],
    ['SR', 'unsupported'],
    ['PR', 'unsupported'],
    ['KO', 'unsupported'],
    ['REG', 'unsupported'],
    ['DOC', 'unsupported'],
    ['RTRECORD', 'unsupported'],
    ['PLAN', 'unsupported'],
    ['FID', 'unsupported'],
    ['ECG', 'unsupported'],
    ['HD', 'unsupported'],
    ['AU', 'unsupported'],
    ['RTDOSE', 'dicom-volume'],
  ])('routes a %s series with WADO instances to %s', (Modality, kind) => {
    expect(
      classifyDisplaySet({ Modality, instances: [{ imageId: wadorsId('7') }] }),
    ).toBe(kind as NiivueLoadKind)
  })

  it('prefers a NIfTI URL even when instances look like DICOM', () => {
    expect(
      classifyDisplaySet({
        Modality: 'CT',
        url: 'https://x/a.nii.gz',
        instances: [{ imageId: wadorsId('5.1') }],
      }),
    ).toBe('nifti')
  })
})

describe('extraDisplaySetsNote (owner Q7)', () => {
  it('names every display set after the first', () => {
    expect(extraDisplaySetsNote([{ SeriesDescription: 'T1' }])).toBeUndefined()
    expect(
      extraDisplaySetsNote([
        { SeriesDescription: 'T1' },
        { SeriesDescription: 'FLAIR' },
        { Modality: 'CT' },
        { displaySetInstanceUID: 'ds-4' },
        {},
      ]),
    ).toBe(
      'Not shown (one series per viewport): FLAIR, CT, ds-4, unnamed series.',
    )
  })
})
