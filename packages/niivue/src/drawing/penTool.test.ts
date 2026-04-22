import { describe, expect, test } from 'bun:test'
import {
  voxelIndex,
  clampToDimension,
  drawPoint,
  drawLine,
  floodFillSection,
  isPenLocationValid,
  isSamePoint,
  getSliceIndices,
  PEN_SLICE_TYPE,
} from './penTool'

// ---------------------------------------------------------------------------
// voxelIndex
// ---------------------------------------------------------------------------
describe('voxelIndex', () => {
  test('computes_flatIndex', () => {
    // x + y * dx + z * dx * dy
    expect(voxelIndex(2, 3, 1, 10, 10)).toBe(2 + 3 * 10 + 1 * 10 * 10)
  })

  test('origin_returnsZero', () => {
    expect(voxelIndex(0, 0, 0, 10, 10)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// clampToDimension
// ---------------------------------------------------------------------------
describe('clampToDimension', () => {
  test('clampsNegativeToZero', () => {
    expect(clampToDimension(-5, 10)).toBe(0)
  })

  test('clampsOverflowToMax', () => {
    expect(clampToDimension(15, 10)).toBe(9)
  })

  test('withinRange_returnsValue', () => {
    expect(clampToDimension(5, 10)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// drawPoint
// ---------------------------------------------------------------------------
describe('drawPoint', () => {
  test('setsVoxelInBitmap', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    drawPoint({
      x: 5,
      y: 3,
      z: 2,
      penValue: 7,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
    })
    const idx = voxelIndex(5, 3, 2, 10, 10)
    expect(bitmap[idx]).toBe(7)
  })

  test('penSize3_axial_setsNeighborhood', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    drawPoint({
      x: 5,
      y: 5,
      z: 5,
      penValue: 1,
      drawBitmap: bitmap,
      dims,
      penSize: 3,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
    })
    // Center should be set
    expect(bitmap[voxelIndex(5, 5, 5, 10, 10)]).toBe(1)
    // Neighbors in the axial plane (x±1, y±1) at same z
    expect(bitmap[voxelIndex(4, 5, 5, 10, 10)]).toBe(1)
    expect(bitmap[voxelIndex(6, 5, 5, 10, 10)]).toBe(1)
    expect(bitmap[voxelIndex(5, 4, 5, 10, 10)]).toBe(1)
    expect(bitmap[voxelIndex(5, 6, 5, 10, 10)]).toBe(1)
    // Z neighbor should NOT be set for axial plane
    expect(bitmap[voxelIndex(5, 5, 4, 10, 10)]).toBe(0)
  })

  test('penOverwritesFalse_doesNotOverwriteExisting', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    const idx = voxelIndex(5, 5, 5, 10, 10)
    bitmap[idx] = 3 // pre-existing label
    drawPoint({
      x: 5,
      y: 5,
      z: 5,
      penValue: 7,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      penOverwrites: false,
    })
    expect(bitmap[idx]).toBe(3) // unchanged
  })

  test('penOverwritesFalse_penValueZero_doesOverwrite', () => {
    // When penValue is 0 (erasing), penOverwrites=false should still allow it
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    const idx = voxelIndex(5, 5, 5, 10, 10)
    bitmap[idx] = 3
    drawPoint({
      x: 5,
      y: 5,
      z: 5,
      penValue: 0,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      penOverwrites: false,
    })
    expect(bitmap[idx]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// drawLine
// ---------------------------------------------------------------------------
describe('drawLine', () => {
  test('horizontalLine_setsAllVoxels', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    drawLine({
      ptA: [0, 5, 5],
      ptB: [9, 5, 5],
      penValue: 1,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
    })
    // All voxels along x from 1 to 9 should be set (drawLine doesn't draw ptA itself)
    for (let x = 1; x <= 9; x++) {
      expect(bitmap[voxelIndex(x, 5, 5, 10, 10)]).toBe(1)
    }
  })

  test('diagonalLine_connectsEndpoints', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    drawLine({
      ptA: [0, 0, 0],
      ptB: [5, 5, 5],
      penValue: 2,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
    })
    // End point should be set
    expect(bitmap[voxelIndex(5, 5, 5, 10, 10)]).toBe(2)
    // At least some intermediate voxels should be set
    let setCount = 0
    for (let i = 0; i < 1000; i++) {
      if (bitmap[i] === 2) setCount++
    }
    expect(setCount).toBeGreaterThanOrEqual(5)
  })

  test('samePoint_noOp', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    drawLine({
      ptA: [5, 5, 5],
      ptB: [5, 5, 5],
      penValue: 1,
      drawBitmap: bitmap,
      dims,
      penSize: 1,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
    })
    // No voxels should be set (Bresenham has zero distance)
    let setCount = 0
    for (let i = 0; i < 1000; i++) {
      if (bitmap[i] !== 0) setCount++
    }
    expect(setCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// floodFillSection
// ---------------------------------------------------------------------------
describe('floodFillSection', () => {
  test('fillsInterior', () => {
    // 5x5 grid with a border drawn at edges of a 3x3 inner region
    const w = 5
    const h = 5
    const img = new Uint8Array(w * h)
    // Draw a border (value=1) forming a 3x3 box at (1,1)-(3,3)
    for (let x = 1; x <= 3; x++) {
      img[x + 1 * w] = 1 // top edge
      img[x + 3 * w] = 1 // bottom edge
    }
    for (let y = 1; y <= 3; y++) {
      img[1 + y * w] = 1 // left edge
      img[3 + y * w] = 1 // right edge
    }
    floodFillSection({
      img2D: img,
      dims2D: [w, h],
      minPt: [0, 0],
      maxPt: [4, 4],
    })
    // Interior point (2,2) should NOT be filled (value remains 0)
    expect(img[2 + 2 * w]).toBe(0)
    // Exterior points should be filled with 2
    expect(img[0 + 0 * w]).toBe(2)
    expect(img[4 + 4 * w]).toBe(2)
  })

  test('edgeBoundaryAlreadyFilled', () => {
    // All pixels pre-filled → flood fill has nothing to do
    const w = 3
    const h = 3
    const img = new Uint8Array(w * h).fill(1)
    floodFillSection({
      img2D: img,
      dims2D: [w, h],
      minPt: [0, 0],
      maxPt: [2, 2],
    })
    // Nothing should change (all pixels already non-zero)
    for (let i = 0; i < w * h; i++) {
      expect(img[i]).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// isPenLocationValid
// ---------------------------------------------------------------------------
describe('isPenLocationValid', () => {
  test('NaN_returnsFalse', () => {
    expect(isPenLocationValid([NaN, 0, 0])).toBe(false)
  })

  test('validCoord_returnsTrue', () => {
    expect(isPenLocationValid([1, 2, 3])).toBe(true)
  })

  test('zeroCoord_returnsTrue', () => {
    expect(isPenLocationValid([0, 0, 0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isSamePoint
// ---------------------------------------------------------------------------
describe('isSamePoint', () => {
  test('identical_returnsTrue', () => {
    expect(isSamePoint([1, 2, 3], [1, 2, 3])).toBe(true)
  })

  test('different_returnsFalse', () => {
    expect(isSamePoint([1, 2, 3], [1, 2, 4])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getSliceIndices
// ---------------------------------------------------------------------------
describe('getSliceIndices', () => {
  test('axial_returns_0_1', () => {
    expect(getSliceIndices(0)).toEqual([0, 1])
  })

  test('coronal_returns_0_2', () => {
    expect(getSliceIndices(1)).toEqual([0, 2])
  })

  test('sagittal_returns_1_2', () => {
    expect(getSliceIndices(2)).toEqual([1, 2])
  })
})
