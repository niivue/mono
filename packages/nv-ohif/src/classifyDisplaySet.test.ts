import { describe, expect, it } from 'bun:test'
import { classifyDisplaySet } from './classifyDisplaySet'

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

  it('returns unsupported when there is nothing loadable', () => {
    expect(classifyDisplaySet({ Modality: 'CT' })).toBe('unsupported')
    expect(classifyDisplaySet({ instances: [{ SOPInstanceUID: '5.1' }] })).toBe(
      'unsupported',
    )
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
