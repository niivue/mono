import { describe, expect, test } from 'bun:test'
import { displaySetToNiivue } from './displaySetToNiivue'

describe('displaySetToNiivue', () => {
  test('extracts a direct NIfTI url and derives a name', () => {
    const spec = displaySetToNiivue({
      SeriesDescription: 'T1',
      url: 'https://example.com/brain.nii.gz',
    })
    expect(spec).toEqual({
      url: 'https://example.com/brain.nii.gz',
      name: 'T1',
    })
  })

  test('falls back to the first instance url', () => {
    const spec = displaySetToNiivue({
      SeriesInstanceUID: '1.2.3',
      instances: [{ url: 'https://example.com/vol.nrrd' }],
    })
    expect(spec).toEqual({ url: 'https://example.com/vol.nrrd', name: '1.2.3' })
  })

  test('accepts NiiVue volume extensions, ignoring query/hash', () => {
    for (const url of [
      'https://x/a.nii',
      'https://x/a.nii.gz?token=abc',
      'https://x/a.mgz#frag',
      'https://x/a.mha',
    ]) {
      expect(displaySetToNiivue({ url })?.url).toBe(url)
    }
  })

  test('returns null for DICOM / non-volume urls (Phase 2)', () => {
    expect(
      displaySetToNiivue({ url: 'https://example.com/image.dcm' }),
    ).toBeNull()
    expect(
      displaySetToNiivue({ url: 'wadors:https://server/studies/1/series/2' }),
    ).toBeNull()
    expect(displaySetToNiivue({ Modality: 'CT', instances: [{}] })).toBeNull()
  })

  test('returns null on an empty display set', () => {
    expect(displaySetToNiivue({})).toBeNull()
  })
})
