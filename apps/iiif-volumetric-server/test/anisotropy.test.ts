import { describe, expect, test } from 'bun:test'

import { VolumeHandle } from '../src/adapters/volumeHandle.ts'
import { renderImageRequest } from '../src/iiif/imageApi.ts'

describe('anisotropy', () => {
  test('VolumeHandle extracts spacing from affine', () => {
    const affine = [
      [0.5, 0, 0, 10],
      [0, 1, 0, 20],
      [0, 0, 2, 30],
      [0, 0, 0, 1],
    ] as const
    const vol = new VolumeHandle({
      shape: [100, 100, 100],
      data: new Uint8Array(100 * 100 * 100),
      dtype: 'uint8',
      affine,
    })
    expect(vol.spacing).toEqual([0.5, 1, 2])
  })

  test('VolumeHandle physicalSliceDims with anisotropy', () => {
    const vol = new VolumeHandle({
      shape: [100, 100, 20],
      spacing: [1, 1, 5],
      data: new Uint8Array(100 * 100 * 20),
      dtype: 'uint8',
    })

    expect(vol.physicalSliceDims('axial')).toEqual([100, 100])
    expect(vol.physicalSliceDims('coronal')).toEqual([100, 100])
    expect(vol.physicalSliceDims('sagittal')).toEqual([100, 100])
  })

  test('renderImageRequest scales anisotropic slices', async () => {
    const data = new Uint8Array(10 * 10 * 2)
    data[0] = 255

    const vol = new VolumeHandle({
      shape: [10, 10, 2],
      spacing: [1, 1, 5],
      data,
      dtype: 'uint8',
    })

    const { buffer, contentType } = await renderImageRequest(
      vol,
      'coronal',
      0,
      {
        region: 'full',
        size: 'max',
        rotation: '0',
        quality: 'default',
        format: 'png',
      },
    )

    expect(contentType).toBe('image/png')
    expect(buffer.length).toBeGreaterThan(0)
  })
})
