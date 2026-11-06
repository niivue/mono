import { describe, expect, it } from 'bun:test'
import { codecFor } from '../src/routes/dicomWsiClientRoutes'

describe('codecFor', () => {
  it('maps the browser and registered codecs', () => {
    expect(codecFor('1.2.840.10008.1.2.4.50')).toBe('image/jpeg')
    expect(codecFor('1.2.840.10008.1.2.4.51')).toBe('image/jpeg')
    expect(codecFor('1.2.840.10008.1.2.4.90')).toBe('image/jp2')
    expect(codecFor('1.2.840.10008.1.2.4.80')).toBe('image/jls')
  })

  it('refuses a syntax no viewer decoder handles', () => {
    for (const uid of ['1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.201', ''])
      expect(() => codecFor(uid)).toThrow(
        expect.objectContaining({
          status: 415,
          message: expect.stringContaining(
            'Unsupported DICOM-WSI transfer syntax',
          ),
        }),
      )
  })
})
