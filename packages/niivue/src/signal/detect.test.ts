import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { niftiBufferIsSignal } from './detect'

const IMAGES_DIR = join(import.meta.dir, '../../../dev-images/images')

function ab(rel: string): ArrayBuffer {
  const buf = readFileSync(join(IMAGES_DIR, rel))
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
}

describe('niftiBufferIsSignal', () => {
  test('nonSpatialMrsFileIsSignal', () => {
    // 1x1x1x1024x64 complex SVS: routed to signal by lack of spatial extent
    expect(niftiBufferIsSignal(ab('signals/svs_se_30.nii.gz'))).toBe(true)
  })

  test('spatialVolumeIsNotSignal', () => {
    expect(niftiBufferIsSignal(ab('volumes/RAS.nii.gz'))).toBe(false)
  })

  test('mrsSidecarShortCircuits', () => {
    // Even non-NIfTI bytes are treated as signal when the sidecar declares MRS.
    const garbage = new Uint8Array([1, 2, 3, 4]).buffer
    expect(
      niftiBufferIsSignal(garbage, { spectrometerFrequency: 297.155 }),
    ).toBe(true)
  })

  test('garbageWithoutSidecarIsNotSignal', () => {
    const garbage = new Uint8Array([1, 2, 3, 4]).buffer
    expect(niftiBufferIsSignal(garbage)).toBe(false)
  })

  test('spatialVolumeWithImagingFrequencyStillVolume', () => {
    // ImagingFrequency is not an MRS marker, so a normal volume stays a volume.
    expect(niftiBufferIsSignal(ab('volumes/RAS.nii.gz'), {})).toBe(false)
  })
})
