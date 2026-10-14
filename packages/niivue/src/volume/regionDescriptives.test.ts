import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import {
  type DescriptivesOptions,
  regionDescriptives,
} from './regionDescriptives'

// A 4x1x1 volume already in RAS order, so getImageDataRAS reads img as is.
function volume(img: number[], slope = 1, inter = 0): NVImage {
  return {
    img: new Float32Array(img),
    dimsRAS: [3, img.length, 1, 1],
    pixDimsRAS: [3, 1, 1, 1],
    img2RASstep: [1, img.length, img.length],
    img2RASstart: [0, 0, 0],
    hdr: { scl_slope: slope, scl_inter: inter },
  } as unknown as NVImage
}

function descriptives(volumes: NVImage[], options: DescriptivesOptions) {
  return regionDescriptives(volumes, () => null, options)
}

describe('regionDescriptives mask labels', () => {
  const intensities = volume([10, 100, 1000, 10000])
  const labels = volume([1, 2, 3, 0])

  test('a plain mask index still counts every non-zero label', () => {
    const stats = descriptives([intensities, labels], { masks: [1] })
    expect(stats?.nVox).toBe(3)
    expect(stats?.mean).toBeCloseTo(370)
  })

  test('keeps only the voxels whose mask value is one of the labels', () => {
    const stats = descriptives([intensities, labels], {
      masks: [{ index: 1, values: [1] }],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(10)
  })

  test('keeps several labels', () => {
    const stats = descriptives([intensities, labels], {
      masks: [{ index: 1, values: [1, 3] }],
    })
    expect(stats?.nVox).toBe(2)
    expect(stats?.mean).toBeCloseTo(505)
  })

  test('can select label 0', () => {
    const stats = descriptives([intensities, labels], {
      masks: [{ index: 1, values: [0] }],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(10000)
  })

  test('intersects a labelled mask with a plain one', () => {
    const half = volume([0, 1, 1, 0])
    const stats = descriptives([intensities, labels, half], {
      masks: [{ index: 1, values: [1, 2] }, 2],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(100)
  })

  test('matches the calibrated mask value', () => {
    // Stored 0..3, calibrated 10..13: label 12 is stored as 2.
    const scaled = volume([0, 1, 2, 3], 1, 10)
    const stats = descriptives([intensities, scaled], {
      masks: [{ index: 1, values: [12] }],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(1000)
  })

  test('refuses an empty label list', () => {
    expect(
      descriptives([intensities, labels], {
        masks: [{ index: 1, values: [] }],
      }),
    ).toBeNull()
  })

  test('refuses a labelled mask index out of bounds', () => {
    expect(
      descriptives([intensities, labels], {
        masks: [{ index: 5, values: [1] }],
      }),
    ).toBeNull()
  })

  test('intersects a labelled mask with the drawing pen values', () => {
    const drawing = new Uint8Array([0, 2, 1, 2])
    const stats = regionDescriptives([intensities, labels], () => drawing, {
      masks: [{ index: 1, values: [2, 3] }],
      isDrawingMask: true,
      drawPenValues: [2],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(100)
  })

  test('refuses a drawing mask when there is no drawing', () => {
    expect(
      regionDescriptives([intensities], () => null, { isDrawingMask: true }),
    ).toBeNull()
  })
})
