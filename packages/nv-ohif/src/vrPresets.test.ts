import { expect, test } from 'bun:test'
import { displayPresetColormap } from './vrPresets'

test('a hanging protocol displayPreset maps to a NiiVue CT colormap', () => {
  // OHIF's mprAnd3DVolumeViewport form: per modality, with a default.
  const hp = [
    {
      options: {
        displayPreset: { CT: 'CT-Bone', MR: 'MR-Default', default: 'CT-Bone' },
      },
    },
  ]
  expect(displayPresetColormap(hp, 'CT')).toBe('ct_bones')
  expect(displayPresetColormap(hp, 'PT')).toBe('ct_bones')
  expect(displayPresetColormap(hp, 'MR')).toBeUndefined()
  expect(displayPresetColormap([{ displayPreset: 'CT-Lung' }], 'CT')).toBe(
    'ct_airways',
  )
  expect(displayPresetColormap(undefined, 'CT')).toBeUndefined()
})
