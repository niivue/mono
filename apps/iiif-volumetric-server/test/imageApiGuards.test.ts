import { describe, expect, test } from 'bun:test'

import { VolumeHandle } from '../src/adapters/volumeHandle.ts'
import { renderImageRequest } from '../src/iiif/imageApi.ts'

function vol(): VolumeHandle {
  return new VolumeHandle({
    shape: [10, 10, 2],
    spacing: [1, 1, 1],
    data: new Uint8Array(10 * 10 * 2),
    dtype: 'uint8',
  })
}

const base = {
  region: 'full',
  size: 'max',
  rotation: '0',
  quality: 'default',
  format: 'png' as const,
}

describe('imageApi request guards', () => {
  test('rejects an oversized requested size (allocation DoS guard)', async () => {
    await expect(
      renderImageRequest(vol(), 'axial', 0, { ...base, size: '30000,30000' }),
    ).rejects.toThrow(/exceeds/)
  })

  test('rejects a non-finite requested size', async () => {
    await expect(
      renderImageRequest(vol(), 'axial', 0, { ...base, size: 'abc,abc' }),
    ).rejects.toThrow(/Invalid size/)
  })

  test('rejects a negative region origin', async () => {
    await expect(
      renderImageRequest(vol(), 'axial', 0, { ...base, region: '-5,0,4,4' }),
    ).rejects.toThrow(/Invalid region/)
  })

  test('still renders a valid bounded request', async () => {
    const { buffer } = await renderImageRequest(vol(), 'axial', 0, {
      ...base,
      size: '8,8',
    })
    expect(buffer.length).toBeGreaterThan(0)
  })
})
