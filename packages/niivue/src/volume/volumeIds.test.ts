import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { assignUniqueVolumeIds, uniqueVolumeId } from './volumeIds'

const vol = (name: string, id: string | undefined = name): NVImage =>
  ({ name, id }) as NVImage

describe('uniqueVolumeId', () => {
  test('returns the base id when it is free', () => {
    expect(uniqueVolumeId('a.nii', [vol('b.nii')])).toBe('a.nii')
  })

  test('suffixes -2, -3, ... for repeats', () => {
    expect(uniqueVolumeId('a.nii', [vol('a.nii')])).toBe('a.nii-2')
    expect(uniqueVolumeId('a.nii', [vol('a.nii'), vol('x', 'a.nii-2')])).toBe(
      'a.nii-3',
    )
  })

  test('reuses the lowest free suffix after a removal', () => {
    expect(uniqueVolumeId('a.nii', [vol('a.nii'), vol('x', 'a.nii-3')])).toBe(
      'a.nii-2',
    )
  })

  test('ignores the volume itself', () => {
    const self = vol('a.nii')
    expect(uniqueVolumeId('a.nii', [self], self)).toBe('a.nii')
  })
})

describe('assignUniqueVolumeIds', () => {
  test('the same URL loaded twice gets distinct ids and keeps its name', () => {
    const vols = [vol('stats.nii'), vol('stats.nii'), vol('stats.nii')]
    assignUniqueVolumeIds(vols)
    expect(vols.map((v) => v.id)).toEqual([
      'stats.nii',
      'stats.nii-2',
      'stats.nii-3',
    ])
    expect(vols.map((v) => v.name)).toEqual([
      'stats.nii',
      'stats.nii',
      'stats.nii',
    ])
  })

  test('dedupes against volumes already in the scene', () => {
    const existing = [vol('anat.nii'), vol('stats.nii')]
    const added = vol('stats.nii')
    assignUniqueVolumeIds([added], existing)
    expect(added.id).toBe('stats.nii-2')
  })

  test('falls back to the name, then to "volume", when there is no id', () => {
    const a = vol('named.nii', undefined)
    const b = { id: undefined } as NVImage
    assignUniqueVolumeIds([a, b])
    expect(a.id).toBe('named.nii')
    expect(b.id).toBe('volume')
  })
})
