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

// A volume along x whose voxel centres sit at x = origin + i * spacing mm
// (row-major matRAS, as NiiVue stores it).
function placed(img: number[], spacing: number, origin = 0): NVImage {
  const v = volume(img) as NVImage & { matRAS: Float32Array }
  v.pixDimsRAS = [3, spacing, 1, 1]
  v.matRAS = new Float32Array([
    spacing,
    0,
    0,
    origin,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ])
  return v
}

describe('regionDescriptives masks on another grid (#337)', () => {
  // A 2 mm map (centres at 0, 2, 4 mm) and a 1 mm atlas (centres 0..5 mm).
  const map2mm = placed([10, 20, 30], 2)
  const atlas1mm = placed([1, 1, 2, 2, 3, 3], 1)

  test('looks up a finer mask at each target voxel centre', () => {
    const stats = descriptives([map2mm, atlas1mm], {
      masks: [{ index: 1, values: [2] }],
    })
    // Target voxel 1 (2 mm) lands on atlas voxel 2 (label 2).
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(20)
    // Reported on the target's own grid.
    expect(stats?.volumeMM3).toBe(2)
  })

  test('a plain mask on another grid counts its non-zero voxels', () => {
    const half = placed([0, 0, 1, 1, 1, 1], 1)
    const stats = descriptives([map2mm, half], { masks: [1] })
    expect(stats?.nVox).toBe(2)
    expect(stats?.mean).toBe(25)
  })

  test('a target voxel outside the mask counts as excluded', () => {
    // Covers 0..2 mm only: target voxel 2 (4 mm) falls outside.
    const partial = placed([5, 5, 5], 1)
    const stats = descriptives([map2mm, partial], { masks: [1] })
    expect(stats?.nVox).toBe(2)
    expect(stats?.mean).toBe(15)
    // Outside matches no label, not even 0.
    const zero = descriptives([map2mm, placed([0, 0, 0], 1)], {
      masks: [{ index: 1, values: [0] }],
    })
    expect(zero?.nVox).toBe(2)
  })

  test('follows the affine, not just the dims', () => {
    // Same 3 voxels, shifted 2 mm: target voxel i reads mask voxel i - 1.
    const shifted = placed([1, 2, 3], 2, 2)
    const stats = descriptives([map2mm, shifted], {
      masks: [{ index: 1, values: [1] }],
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(20)
  })

  test('maps the drawing from the base grid onto a coarser target', () => {
    // The drawing lives on the base volume (index 0, the 1 mm atlas).
    const drawing = new Uint8Array([0, 0, 0, 0, 1, 1])
    const stats = regionDescriptives([atlas1mm, map2mm], () => drawing, {
      volumeIndex: 1,
      isDrawingMask: true,
    })
    expect(stats?.nVox).toBe(1)
    expect(stats?.mean).toBe(30)
  })

  test('refuses grids that differ when an affine is missing', () => {
    expect(descriptives([map2mm, volume([1, 1])], { masks: [1] })).toBeNull()
  })
})
