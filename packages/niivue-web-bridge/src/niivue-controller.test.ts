import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@niivue/niivue'
import { volumeSummaries } from './niivue-controller'

describe('volumeSummaries', () => {
  test('reports RAS geometry and fills display defaults', () => {
    const vol = {
      name: 'mni152.nii.gz',
      calMin: 40,
      calMax: 80,
      globalMin: 0,
      globalMax: 91,
      dimsRAS: [3, 207, 256, 215, 1],
      pixDimsRAS: [1, 0.74, 0.74, 0.74, 0],
      hdr: { dims: [3, 215, 256, 207], pixDims: [1, 2, 2, 2] },
    } as unknown as NVImage
    expect(volumeSummaries([vol])).toEqual([
      {
        name: 'mni152.nii.gz',
        colormap: 'gray',
        colormapStops: [
          [0, 0, 0, 0],
          [1, 1, 1, 1],
        ],
        calMin: 40,
        calMax: 80,
        globalMin: 0,
        globalMax: 91,
        opacity: 1,
        dims: [207, 256, 215],
        pixDims: [0.74, 0.74, 0.74],
      },
    ])
  })
})
