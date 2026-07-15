import { describe, expect, test } from 'bun:test'
import {
  clampToDimension,
  drawLine,
  drawPoint,
  drawSphere,
  floodFill3D,
  floodFillSection,
  getSliceIndices,
  isPenLocationValid,
  isSamePoint,
  magicWand3D,
  PEN_SLICE_TYPE,
  voxelIndex,
} from './penTool'

describe('drawSphere', () => {
  const dims = [3, 5, 5, 5] // [ndim, dx, dy, dz]
  const idx = (x: number, y: number, z: number) => voxelIndex(x, y, z, 5, 5)

  test('radius 0 paints a single voxel', () => {
    const bmp = new Uint8Array(125)
    drawSphere({
      x: 2,
      y: 2,
      z: 2,
      radius: 0,
      penValue: 7,
      drawBitmap: bmp,
      dims,
      penOverwrites: true,
    })
    expect(bmp[idx(2, 2, 2)]).toBe(7)
    expect(bmp.reduce((a, b) => a + (b ? 1 : 0), 0)).toBe(1)
  })

  test('radius 1 paints a 6-neighbour ball (centre + face neighbours)', () => {
    const bmp = new Uint8Array(125)
    drawSphere({
      x: 2,
      y: 2,
      z: 2,
      radius: 1,
      penValue: 3,
      drawBitmap: bmp,
      dims,
      penOverwrites: true,
    })
    // centre + 6 axis neighbours are within radius 1; corners (dist² = 2,3) are not
    expect(bmp[idx(2, 2, 2)]).toBe(3)
    expect(bmp[idx(1, 2, 2)]).toBe(3)
    expect(bmp[idx(3, 2, 2)]).toBe(3)
    expect(bmp[idx(2, 1, 2)]).toBe(3)
    expect(bmp[idx(2, 2, 3)]).toBe(3)
    expect(bmp[idx(1, 1, 2)]).toBe(0) // diagonal excluded
    expect(bmp.reduce((a, b) => a + (b ? 1 : 0), 0)).toBe(7)
  })

  test('clips at the volume boundary', () => {
    const bmp = new Uint8Array(125)
    drawSphere({
      x: 0,
      y: 0,
      z: 0,
      radius: 1,
      penValue: 1,
      drawBitmap: bmp,
      dims,
      penOverwrites: true,
    })
    // only the in-bounds half of the ball is painted; no out-of-range writes
    expect(bmp[idx(0, 0, 0)]).toBe(1)
    expect(bmp[idx(1, 0, 0)]).toBe(1)
    expect(bmp.reduce((a, b) => a + (b ? 1 : 0), 0)).toBe(4)
  })

  test('penOverwrites=false skips non-zero voxels', () => {
    const bmp = new Uint8Array(125)
    bmp[idx(2, 2, 2)] = 9
    drawSphere({
      x: 2,
      y: 2,
      z: 2,
      radius: 1,
      penValue: 3,
      drawBitmap: bmp,
      dims,
      penOverwrites: false,
    })
    expect(bmp[idx(2, 2, 2)]).toBe(9) // preserved
    expect(bmp[idx(1, 2, 2)]).toBe(3) // empty neighbour painted
  })
})

// ---------------------------------------------------------------------------
// floodFill3D
// ---------------------------------------------------------------------------
describe('floodFill3D', () => {
  const dims = [3, 5, 5, 5] // [ndim, dx, dy, dz]
  const idx = (x: number, y: number, z: number) => voxelIndex(x, y, z, 5, 5)

  test('fills the whole volume when keep is always true', () => {
    const bmp = new Uint8Array(125)
    const res = floodFill3D({
      seed: [2, 2, 2],
      drawBitmap: bmp,
      dims,
      penValue: 4,
      keep: () => true,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(125)
    expect(res.hitCap).toBe(false)
    expect(res.min).toEqual([0, 0, 0])
    expect(res.max).toEqual([4, 4, 4])
    expect(bmp.every((v) => v === 4)).toBe(true)
  })

  test('grows only the 6-connected region that passes keep', () => {
    const bmp = new Uint8Array(125)
    // Region: the x=0 plane is "tissue"; a lone voxel at x=4 is isolated.
    const keep = (x: number, _y: number, _z: number) => x === 0 || x === 4
    const res = floodFill3D({
      seed: [0, 0, 0],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      keep,
      fillOverwrites: true,
    })
    // Only the connected x=0 plane (25 voxels) is filled; the x=4 island is not
    // reachable across the x=1..3 gap.
    expect(res.filled).toBe(25)
    expect(bmp[idx(0, 3, 4)]).toBe(1)
    expect(bmp[idx(4, 0, 0)]).toBe(0)
    expect(res.min).toEqual([0, 0, 0])
    expect(res.max).toEqual([0, 4, 4])
  })

  test('returns filled 0 when the seed fails keep', () => {
    const bmp = new Uint8Array(125)
    const res = floodFill3D({
      seed: [2, 2, 2],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      keep: () => false,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(0)
    expect(bmp.every((v) => v === 0)).toBe(true)
  })

  test('honors maxVoxels cap and reports hitCap', () => {
    const bmp = new Uint8Array(125)
    const res = floodFill3D({
      seed: [2, 2, 2],
      drawBitmap: bmp,
      dims,
      penValue: 2,
      keep: () => true,
      fillOverwrites: true,
      maxVoxels: 10,
    })
    expect(res.filled).toBe(10)
    expect(res.hitCap).toBe(true)
  })

  test('fillOverwrites=false preserves existing nonzero draw voxels', () => {
    const bmp = new Uint8Array(125)
    bmp[idx(2, 2, 2)] = 9
    const res = floodFill3D({
      seed: [0, 0, 0],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      keep: () => true,
      fillOverwrites: false,
    })
    // Every voxel except the preserved one gets painted.
    expect(bmp[idx(2, 2, 2)]).toBe(9)
    expect(res.filled).toBe(124)
  })

  test('eraser fill (penValue 0) clears a connected painted region', () => {
    const bmp = new Uint8Array(125).fill(5)
    const res = floodFill3D({
      seed: [2, 2, 2],
      drawBitmap: bmp,
      dims,
      penValue: 0,
      keep: () => true,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(125)
    expect(bmp.every((v) => v === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// magicWand3D
// ---------------------------------------------------------------------------
describe('magicWand3D', () => {
  const dims = [3, 5, 5, 5] // [ndim, dx, dy, dz]
  const idx = (x: number, y: number, z: number) => voxelIndex(x, y, z, 5, 5)

  // Source volume: a 3x3x3 bright cube (value 100) in one corner, rest 0.
  const makeSample = () => {
    const src = new Float32Array(125)
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++) src[idx(x, y, z)] = 100
    return (x: number, y: number, z: number) => src[idx(x, y, z)]
  }

  test('grows the intensity-similar connected region within tolerance', () => {
    const bmp = new Uint8Array(125)
    const res = magicWand3D({
      seed: [1, 1, 1],
      drawBitmap: bmp,
      dims,
      penValue: 3,
      sample: makeSample(),
      tolerance: 5,
      fillOverwrites: true,
    })
    // The whole 27-voxel bright cube is filled; nothing outside it.
    expect(res.filled).toBe(27)
    expect(bmp[idx(0, 0, 0)]).toBe(3)
    expect(bmp[idx(2, 2, 2)]).toBe(3)
    expect(bmp[idx(3, 0, 0)]).toBe(0) // value 0, outside the band
    expect(res.min).toEqual([0, 0, 0])
    expect(res.max).toEqual([2, 2, 2])
  })

  test('tolerance 0 requires an exact intensity match', () => {
    const sample = makeSample()
    const bmp = new Uint8Array(125)
    // Seed on a background voxel: fills the connected background (125 - 27 cube).
    const res = magicWand3D({
      seed: [4, 4, 4],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      sample,
      tolerance: 0,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(98) // 125 total - 27 bright cube
    expect(bmp[idx(1, 1, 1)]).toBe(0) // cube untouched
  })

  test('out-of-bounds seed fills nothing', () => {
    const bmp = new Uint8Array(125)
    const res = magicWand3D({
      seed: [9, 9, 9],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      sample: makeSample(),
      tolerance: 10,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(0)
    expect(bmp.every((v) => v === 0)).toBe(true)
  })

  test('a wide tolerance floods everything reachable', () => {
    const bmp = new Uint8Array(125)
    const res = magicWand3D({
      seed: [1, 1, 1],
      drawBitmap: bmp,
      dims,
      penValue: 2,
      sample: makeSample(),
      tolerance: 1000,
      fillOverwrites: true,
    })
    expect(res.filled).toBe(125)
  })

  test('restrictToSlice confines the grow to one plane (2D)', () => {
    const bmp = new Uint8Array(125)
    // Wide tolerance would fill the whole volume in 3D; pinning z=2 keeps it to
    // that axial slice (5x5 = 25 voxels).
    const res = magicWand3D({
      seed: [2, 2, 2],
      drawBitmap: bmp,
      dims,
      penValue: 1,
      sample: () => 50, // uniform, so only the plane restriction bounds it
      tolerance: 1000,
      fillOverwrites: true,
      restrictToSlice: { axis: 2, index: 2 },
    })
    expect(res.filled).toBe(25)
    expect(res.min).toEqual([0, 0, 2])
    expect(res.max).toEqual([4, 4, 2])
    // A voxel on a different z is untouched.
    expect(bmp[idx(2, 2, 3)]).toBe(0)
  })
})

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

  test('penSize5_isCircle_skipsCorners', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    
    drawPoint({
      x: 5,
      y: 5,
      z: 5,
      penValue: 1,
      drawBitmap: bitmap,
      dims,
      penSize: 5, // radius = 2.5
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      isCircle: true,
    })

    // Center is set
    expect(bitmap[voxelIndex(5, 5, 5, 10, 10)]).toBe(1)
    
    // (i=2, j=0) -> 2*2 + 0 = 4 <= 6.25, should be set
    expect(bitmap[voxelIndex(7, 5, 5, 10, 10)]).toBe(1)
    
    // (i=2, j=2) -> 2*2 + 2*2 = 8 > 6.25, should be skipped (corner of 5x5 square)
    expect(bitmap[voxelIndex(7, 7, 5, 10, 10)]).toBe(0)
  })

  test('penSize5_square_fillsCorners', () => {
    const dims = [3, 10, 10, 10]
    const bitmap = new Uint8Array(1000)
    
    drawPoint({
      x: 5,
      y: 5,
      z: 5,
      penValue: 1,
      drawBitmap: bitmap,
      dims,
      penSize: 5, // radius = 2.5
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      isCircle: false,
    })

    // Corner of 5x5 square (i=2, j=2) should be set when not a circle
    expect(bitmap[voxelIndex(7, 7, 5, 10, 10)]).toBe(1)
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
