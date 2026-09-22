import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import { centeredAffine } from './channelVolumeFile'
import { type TiffVolume, tiffVolumeAffine } from './tiffVolume'

describe('centeredAffine', () => {
  const cases: Array<{
    name: string
    dims: [number, number, number]
    spacing: [number, number, number]
    translation: [number, number, number]
  }> = [
    {
      name: 'unit spacing',
      dims: [4, 2, 3],
      spacing: [1, 1, 1],
      translation: [-1.5, -0.5, -1],
    },
    {
      // -0 rather than 0: toEqual distinguishes them, and -(1-1)*0.5*s is -0.
      name: 'single voxel sits exactly on the origin',
      dims: [1, 1, 1],
      spacing: [2, 2, 2],
      translation: [-0, -0, -0],
    },
    {
      name: 'anisotropic microscopy spacing',
      dims: [3, 3, 2],
      spacing: [0.5, 0.5, 4],
      translation: [-0.5, -0.5, -2],
    },
  ]

  for (const { name, dims, spacing, translation } of cases) {
    test(name, () => {
      expect(centeredAffine(dims, spacing)).toEqual([
        spacing[0],
        0,
        0,
        translation[0],
        0,
        spacing[1],
        0,
        translation[1],
        0,
        0,
        spacing[2],
        translation[2],
        0,
        0,
        0,
        1,
      ])
    })
  }

  test('agrees with tiffVolumeAffine so the loaders cannot drift', () => {
    // omeTiffLoader.ts relies on these two staying identical: the TIFF path
    // builds its affine with tiffVolumeAffine, every other channel loader
    // with centeredAffine.
    const volume: TiffVolume = {
      name: 'parity',
      dims: [5, 3, 2],
      spacingUm: [0.25, 0.25, 3],
      datatypeCode: NiiDataType.DT_UINT8,
      bitsPerVoxel: 8,
      img: new Uint8Array(5 * 3 * 2),
    }
    expect(tiffVolumeAffine(volume).flat()).toEqual(
      centeredAffine(volume.dims, volume.spacingUm),
    )
  })
})
