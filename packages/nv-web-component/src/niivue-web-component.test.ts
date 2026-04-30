import { describe, expect, test } from 'bun:test'

import {
  defaultElementName,
  extractVisualProps,
  volumeIdentity,
  volumeIndexByKey,
  volumeKey,
  volumeVisualUpdates,
} from './niivue-web-component'

describe('defaultElementName', () => {
  test('uses the expected default custom element name', () => {
    expect(defaultElementName).toBe('niivue-viewer')
  })
})

describe('volume helpers', () => {
  test('keys volumes by string URL or file name', () => {
    const file = new File([''], 'local.nii.gz')

    expect(volumeKey({ url: '/volumes/mni152.nii.gz' })).toBe(
      '/volumes/mni152.nii.gz',
    )
    expect(volumeKey({ url: file })).toBe('local.nii.gz')
  })

  test('matches loaded volumes by URL before name', () => {
    expect(volumeIdentity({ url: '/volumes/mni152.nii.gz', name: 'MNI' })).toBe(
      '/volumes/mni152.nii.gz',
    )
    expect(volumeIdentity({ url: '', name: 'local.nii.gz' })).toBe(
      'local.nii.gz',
    )
  })

  test('extracts declarative visual props', () => {
    expect(
      extractVisualProps({
        url: '/volumes/mni152.nii.gz',
        colormap: 'gray',
        calMin: 10,
        calMax: 200,
        opacity: 0.5,
      }),
    ).toEqual({
      colormap: 'gray',
      calMin: 10,
      calMax: 200,
      opacity: 0.5,
    })
  })

  test('diffs only defined changed visual props', () => {
    expect(
      volumeVisualUpdates(
        { colormap: 'hot', calMax: 200 },
        { colormap: 'gray', calMin: 10, calMax: 200, opacity: 0.5 },
      ),
    ).toEqual({ colormap: 'hot' })
  })

  test('finds loaded volume indices by URL or name key', () => {
    const volumes = [
      { url: '/volumes/background.nii.gz', name: 'background' },
      { url: '', name: 'overlay.nii.gz' },
    ]

    expect(volumeIndexByKey(volumes, '/volumes/background.nii.gz')).toBe(0)
    expect(volumeIndexByKey(volumes, 'overlay.nii.gz')).toBe(1)
    expect(volumeIndexByKey(volumes, 'missing.nii.gz')).toBe(-1)
  })
})
