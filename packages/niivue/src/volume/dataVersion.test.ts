import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { commitDirtyVolumes, markVolumeDataChanged } from './dataVersion'

// Only the change-tracking fields matter; a structural cast keeps the fixture
// small instead of building a full NVImage.
function makeVol(fields: Partial<NVImage> = {}): NVImage {
  return { ...fields } as NVImage
}

describe('markVolumeDataChanged', () => {
  test('bumps the data version from absent (0) and clears isDirty', () => {
    const vol = makeVol({ isDirty: true })
    markVolumeDataChanged(vol)
    expect(vol._dataVersion).toBe(1)
    expect(vol.isDirty).toBe(false)
  })

  test('every call is a new version', () => {
    const vol = makeVol({ _dataVersion: 4 })
    markVolumeDataChanged(vol)
    markVolumeDataChanged(vol)
    expect(vol._dataVersion).toBe(6)
  })
})

describe('commitDirtyVolumes', () => {
  test('bumps only the flagged volumes and returns them', () => {
    const clean = makeVol({ _dataVersion: 2 })
    const dirty = makeVol({ _dataVersion: 2, isDirty: true })
    const neverUploaded = makeVol({ isDirty: true })
    const result = commitDirtyVolumes([clean, dirty, neverUploaded])
    expect(result).toEqual([dirty, neverUploaded])
    expect(clean._dataVersion).toBe(2)
    expect(dirty._dataVersion).toBe(3)
    expect(neverUploaded._dataVersion).toBe(1)
  })

  test('clears the flag, so a second update re-uploads nothing', () => {
    const vol = makeVol({ isDirty: true })
    commitDirtyVolumes([vol])
    expect(vol.isDirty).toBe(false)
    expect(commitDirtyVolumes([vol])).toEqual([])
    expect(vol._dataVersion).toBe(1)
  })

  test('a flag set again after a commit bumps the version again', () => {
    // An edit made while the previous upload is still running must not be
    // lost: it gets its own version, which the queued follow-up uploads.
    const vol = makeVol({ isDirty: true })
    commitDirtyVolumes([vol])
    vol.isDirty = true
    commitDirtyVolumes([vol])
    expect(vol._dataVersion).toBe(2)
  })

  test('ignores a chunkSource volume: clears its flag without a bump', () => {
    // Its bricks come from the source, so a bump would only re-stream them.
    const streamed = makeVol({
      _dataVersion: 3,
      isDirty: true,
      chunkSource: (() => {}) as unknown as NVImage['chunkSource'],
    })
    expect(commitDirtyVolumes([streamed])).toEqual([])
    expect(streamed.isDirty).toBe(false)
    expect(streamed._dataVersion).toBe(3)
  })
})
