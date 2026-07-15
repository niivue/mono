import { describe, expect, test } from 'bun:test'

import { getFileExt } from './NVLoader'

describe('getFileExt', () => {
  test('ignores query strings and hash fragments for URL inputs', () => {
    expect(getFileExt('/volumes/fibsem/raw.nii.gz?level=0&bbox=1,2,3')).toBe(
      'NII',
    )
    expect(getFileExt('/volumes/fibsem/raw.nii.gz#frame')).toBe('NII')
    expect(getFileExt('/meshes/cortex.iwm.cbor?token=abc')).toBe('IWM.CBOR')
  })
})
