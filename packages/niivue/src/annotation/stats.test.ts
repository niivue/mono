import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type { AnnotationPoint, NVImage, VectorAnnotation } from '@/NVTypes'
import { pointInRing } from './pointInRing'
import { generatePolygonFromPoints, generateShape } from './shapes'
import { computeAnnotationStats, shapeAngle } from './stats'

// 20x20x1 axial grid, 1 mm voxels, voxel value = its x index.
const N = 20
const img = new Float32Array(N * N)
for (let i = 0; i < img.length; i++) img[i] = i % N
const volume = {
  img,
  hdr: { scl_slope: 1, scl_inter: 0 },
  dimsRAS: [3, N, N, 1],
  pixDimsRAS: [1, 1, 1, 1],
  matRAS: mat4.create(),
  img2RASstart: [0, 0, 0],
  img2RASstep: [1, N, N * N],
  nVox3D: N * N,
} as unknown as NVImage

const square = (x: number, y: number, size: number): AnnotationPoint[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
]

const annotation = (
  polygons: VectorAnnotation['polygons'],
): VectorAnnotation => ({
  id: 'a',
  label: 1,
  group: 'g',
  sliceType: SLICE_TYPE.AXIAL,
  slicePosition: 0,
  polygons,
  shape: { type: 'freehand', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
  style: { fillColor: [1, 0, 0, 1], strokeColor: [1, 0, 0, 1], strokeWidth: 1 },
})

describe('computeAnnotationStats', () => {
  test('counts a square ROI', () => {
    const stats = computeAnnotationStats(
      annotation([{ outer: square(0, 0, 4), holes: [] }]),
      volume,
    )
    expect(stats?.area).toBe(16)
    expect(stats?.max).toBe(3)
  })

  test('measures a constructed angle', () => {
    const right = {
      ...annotation([]),
      shape: {
        type: 'measureAngle' as const,
        start: { x: 10, y: 0 },
        end: { x: 0, y: 0 },
        start2: { x: 0, y: 0 },
        end2: { x: 0, y: 10 },
      },
    }
    expect(computeAnnotationStats(right, volume)?.angle).toBeCloseTo(90, 9)
  })

  // Review of #836: on an oblique slice the 2D arms project to 53.13 degrees
  // for a drawn right angle; recomputing keeps the angle drawing recorded.
  test('keeps the angle recorded on an oblique slice', () => {
    const oblique = {
      ...annotation([]),
      shape: {
        type: 'measureAngle' as const,
        start: { x: 10, y: 5 },
        end: { x: 0, y: 0 },
        start2: { x: 0, y: 0 },
        end2: { x: 10, y: -5 },
      },
      stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, angle: 90 },
    }
    expect(computeAnnotationStats(oblique, volume)?.angle).toBe(90)
  })

  test('skips voxels with no data (NaN)', () => {
    const holed = new Float32Array(img)
    holed[1] = Number.NaN
    const stats = computeAnnotationStats(
      annotation([{ outer: square(0, 0, 4), holes: [] }]),
      { ...volume, img: holed } as NVImage,
    )
    expect(Number.isFinite(stats?.mean)).toBe(true)
    expect(stats?.max).toBe(3)
  })

  test('covers every piece of a split ROI and skips its holes', () => {
    const stats = computeAnnotationStats(
      annotation([
        { outer: square(0, 0, 4), holes: [square(1, 1, 2)] },
        { outer: square(10, 10, 3), holes: [] },
      ]),
      volume,
    )
    expect(stats?.area).toBe(12 + 9)
    expect(stats?.min).toBe(0)
    expect(stats?.max).toBe(12)
  })
})

describe('computeAnnotationStats area', () => {
  const shaped = (
    type: 'measureRect' | 'measureEllipse',
    start: AnnotationPoint,
    end: AnnotationPoint,
  ): VectorAnnotation => ({
    ...annotation(generateShape(type, start, end, 1)),
    shape: { type, start, end },
  })

  test('isAreaGeometric: exact rectangle and ellipse areas; default counts voxels', () => {
    const rect = shaped('measureRect', { x: 0.5, y: 0.5 }, { x: 4.7, y: 3.2 })
    // Default: voxel centres x 1..4, y 1..3.
    expect(computeAnnotationStats(rect, volume)?.area).toBe(12)
    expect(computeAnnotationStats(rect, volume, true)?.area).toBeCloseTo(
      4.2 * 2.7,
      10,
    )
    const ell = shaped('measureEllipse', { x: 2, y: 2 }, { x: 12, y: 8 })
    expect(computeAnnotationStats(ell, volume, true)?.area).toBeCloseTo(
      (Math.PI * 10 * 6) / 4,
      10,
    )
  })

  test('isAreaGeometric: a freehand outline is its polygon area minus holes', () => {
    const stats = computeAnnotationStats(
      annotation([{ outer: square(1, 1, 8), holes: [square(3, 3, 2)] }]),
      volume,
      true,
    )
    expect(stats?.area).toBeCloseTo(64 - 4, 10)
  })
})

test('the scanline fill selects exactly the voxels pointInRing does', () => {
  // A concave, float-vertex star with a hole, on the 20x20 grid.
  const outer: AnnotationPoint[] = Array.from({ length: 14 }, (_, i) => {
    const r = i % 2 ? 3.3 : 8.6
    const t = (i / 14) * Math.PI * 2 + 0.17
    return { x: 9.7 + r * Math.cos(t), y: 10.2 + r * Math.sin(t) }
  })
  const hole = square(8.4, 8.9, 2.3)
  let expected = 0
  let maxX = -1
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      if (pointInRing({ x, y }, outer) && !pointInRing({ x, y }, hole)) {
        expected++
        maxX = Math.max(maxX, x)
      }
  const stats = computeAnnotationStats(
    annotation([{ outer, holes: [hole] }]),
    volume,
  )
  expect(stats?.area).toBe(expected)
  expect(stats?.max).toBe(maxX) // voxel value = its x index
})

test('an intact circle selects voxels inside the true curve, not its 64-gon', () => {
  const start = { x: 2.2, y: 2.3 }
  // r = 6.8, centre (9, 9.1): centres (6, 3) and (12, 3) lie outside the 64-gon
  // but inside the circle.
  const end = { x: 15.8, y: 15.9 }
  const ann: VectorAnnotation = {
    ...annotation(generateShape('measureCircle', start, end, 1)),
    shape: { type: 'measureCircle', start, end },
  }
  let expected = 0
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      if ((x - 9) ** 2 + (y - 9.1) ** 2 < 6.8 ** 2) expected++
  expect(computeAnnotationStats(ann, volume)?.area).toBe(expected)
})

describe('computeAnnotationStats edge cases', () => {
  const rect = (
    start: AnnotationPoint,
    end: AnnotationPoint,
  ): VectorAnnotation => ({
    ...annotation(generateShape('measureRect', start, end, 1)),
    shape: { type: 'measureRect', start, end },
  })

  test('an ROI wholly off the image measures nothing (no throw)', () => {
    expect(
      computeAnnotationStats(rect({ x: 25, y: 2 }, { x: 30, y: 6 }), volume),
    ).toBeNull()
    expect(
      computeAnnotationStats(rect({ x: -10, y: 2 }, { x: -5, y: 6 }), volume),
    ).toBeNull()
  })

  test('an integer-centred circle includes centres on its curve, as cornerstone', () => {
    const start = { x: 5, y: 5 }
    const end = { x: 15, y: 15 } // centre (10, 10), r = 5
    const stats = computeAnnotationStats(
      {
        ...annotation(generateShape('measureCircle', start, end, 1)),
        shape: { type: 'measureCircle', start, end },
      },
      volume,
    )
    // Cornerstone's createEllipseShape on this grid: 81 voxels, mean 10, max 15.
    expect(stats?.area).toBe(81)
    expect(stats?.mean).toBeCloseTo(10, 10)
    expect(stats?.max).toBe(15)
  })

  test('geometric area on a tilted slice is the in-plane area, not its projection', () => {
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const tilted = {
      ...volume,
      img: new Float32Array(N * N * N).fill(1),
      dimsRAS: [3, N, N, N],
      matRAS: new Float32Array([
        1,
        0,
        0,
        0,
        0,
        c,
        -s,
        0,
        0,
        s,
        c,
        0,
        0,
        0,
        0,
        1,
      ]),
      nVox3D: N * N * N,
    } as unknown as NVImage
    // An 8 x 8 mm square on the slice projects to 8 x 8cos30 on the axial plane.
    const ann = {
      ...rect({ x: 2, y: 2 * c }, { x: 10, y: 10 * c }),
      slicePosition: 2 * s,
    }
    expect(computeAnnotationStats(ann, tilted, true)?.area).toBeCloseTo(64, 6)
  })
})

test('on a tilted volume an intact ellipse and the same freehand outline select the same voxels', () => {
  const M = 40
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  const tilted = {
    ...volume,
    img: new Float32Array(M * M * M).fill(1),
    dimsRAS: [3, M, M, M],
    matRAS: new Float32Array([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]),
    img2RASstep: [1, M, M * M],
    nVox3D: M * M * M,
  } as unknown as NVImage
  const start = { x: 14, y: 22 }
  const end = { x: 26, y: 32 } // 12 x 10 mm, centre (20, 27)
  const polygons = generateShape('measureEllipse', start, end, 1)
  const ellipse: VectorAnnotation = {
    ...annotation(polygons),
    slicePosition: 40,
    shape: { type: 'measureEllipse', start, end },
  }
  const freehand: VectorAnnotation = {
    ...annotation(polygons),
    slicePosition: 40,
  }
  // Brute force on the slice's voxel plane k: voxel (i, j, k) -> mm (i, cj - sk, sj + ck).
  const first = polygons[0]?.outer[0] as AnnotationPoint
  const k = Math.round(-s * first.y + c * 40) // voxel depth of the first vertex
  let expected = 0
  for (let i = 0; i < M; i++)
    for (let j = 0; j < M; j++) {
      const x = i
      const y = c * j - s * k
      if (((x - 20) / 6) ** 2 + ((y - 27) / 5) ** 2 <= 1) expected++
    }
  const e = computeAnnotationStats(ellipse, tilted)?.area as number
  const f = computeAnnotationStats(freehand, tilted)?.area as number
  expect(e).toBe(expected)
  // The 64-gon sits just inside the curve: at most a few edge voxels fewer.
  expect(e - f).toBeGreaterThanOrEqual(0)
  expect(e - f).toBeLessThanOrEqual(4)
})

describe('measurePoint on 4D and oblique volumes (R12 audit)', () => {
  const n = 20
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  const vol = (img: Float32Array, matRAS: number[], frame4D = 0) =>
    ({
      img,
      hdr: { scl_slope: 1, scl_inter: 0 },
      dimsRAS: [3, n, n, n],
      pixDimsRAS: [1, 1, 1, 1],
      matRAS: new Float32Array(matRAS),
      img2RASstart: [0, 0, 0],
      img2RASstep: [1, n, n * n],
      nVox3D: n * n * n,
      frame4D,
    }) as unknown as NVImage
  const probe = (p: AnnotationPoint, z: number): VectorAnnotation => ({
    ...annotation(generateShape('measurePoint', p, p, 1)),
    slicePosition: z,
    anchorMM: [p.x, p.y, z],
    shape: { type: 'measurePoint', start: p, end: p },
  })
  test('reads the displayed 4D frame', () => {
    const img = new Float32Array(2 * n * n * n).fill(7, 0, n * n * n)
    img.fill(101, n * n * n)
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(
      computeAnnotationStats(probe({ x: 4, y: 4 }, 5), vol(img, id, 1))?.value,
    ).toBe(101)
  })
  test('a point moved on an oblique slice stays on its voxel plane', () => {
    const img = new Float32Array(n * n * n)
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          img[x + y * n + z * n * n] = 10000 * z + 100 * y + x
    const v = vol(img, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1])
    const ann = probe({ x: 4, y: c * 4 - s * 5 }, s * 4 + c * 5)
    expect(computeAnnotationStats(ann, v)?.value).toBe(50404)
    // Moved in slice-2D only (an API move keeps the anchor): voxel (4, 12, 5).
    const end = { x: 4, y: c * 12 - s * 5 }
    ann.shape = { type: 'measurePoint', start: end, end }
    ann.polygons = generateShape('measurePoint', end, end, 1)
    expect(computeAnnotationStats(ann, v)?.value).toBe(51204)
  })
})

// OHIF's Angle and CobbAngle spec clicks, taken as slice-2D points.
describe('shapeAngle', () => {
  test('measureAngle: the angle at the vertex', () => {
    const vertex = { x: 450, y: 250 }
    const angle = shapeAngle({
      type: 'measureAngle',
      start: { x: 550, y: 200 },
      end: vertex,
      start2: vertex,
      end2: { x: 550, y: 300 },
    })
    expect(angle).toBeCloseTo(53.1301, 4)
  })
  test('measureCobbAngle: the acute angle between the lines', () => {
    const angle = shapeAngle({
      type: 'measureCobbAngle',
      start: { x: 515, y: 212 },
      end: { x: 616, y: 207 },
      start2: { x: 527, y: 293 },
      end2: { x: 625, y: 291 },
    })
    expect(angle).toBeCloseTo(1.665, 3)
  })
})

test('a tilted ROI samples the voxel plane of its anchor, not of its first vertex', () => {
  const M = 40
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  const img = new Float32Array(M * M * M)
  for (let i = 0; i < img.length; i++) img[i] = Math.floor(i / (M * M)) // = k
  const tilted = {
    ...volume,
    img,
    dimsRAS: [3, M, M, M],
    matRAS: new Float32Array([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]),
    img2RASstep: [1, M, M * M],
    nVox3D: M * M * M,
  } as unknown as NVImage
  // Drawn on voxel plane k = 10 through voxel (20, 20, 10); a reversed drag
  // puts the first vertex far from the anchor along the tilt.
  const anchorMM: [number, number, number] = [
    20,
    20 * c - 10 * s,
    20 * s + 10 * c,
  ]
  const start = { x: 28, y: anchorMM[1] + 8 }
  const end = { x: 12, y: anchorMM[1] - 8 }
  const ann: VectorAnnotation = {
    ...annotation(generateShape('measureRect', start, end, 1)),
    slicePosition: anchorMM[2],
    anchorMM,
    shape: { type: 'measureRect', start, end },
  }
  expect(computeAnnotationStats(ann, tilted)?.mean).toBe(10)
})

test('isAreaGeometric: a sub-voxel ROI reports its area with no voxel stats', () => {
  const start = { x: 0.2, y: 0.2 } // between voxel centres
  const end = { x: 0.8, y: 0.8 }
  const ann: VectorAnnotation = {
    ...annotation(generateShape('measureRect', start, end, 1)),
    shape: { type: 'measureRect', start, end },
  }
  expect(computeAnnotationStats(ann, volume)).toBeNull()
  const stats = computeAnnotationStats(ann, volume, true)
  expect(stats?.area).toBeCloseTo(0.36, 10)
  expect(stats?.mean).toBe(0)
})

test('a large rotated ellipse counts voxels between its 64-gon and the true curve', () => {
  // 4001 x 5 voxels rotated pi/64 in-plane: the curve's extreme along i falls
  // midway between gon vertices, r(1 - cos(pi/64)) ~ 2.2 voxels beyond the gon.
  const W = 4001
  const H = 5
  const c = Math.cos(Math.PI / 64)
  const s = Math.sin(Math.PI / 64)
  const img = new Float32Array(W * H)
  img[2 * W + 200] = -7 // voxel (200, 2): 1800 voxels from the centre, inside r = 1800.1
  const rotated = {
    ...volume,
    img,
    dimsRAS: [3, W, H, 1],
    matRAS: new Float32Array([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    img2RASstep: [1, W, W * H],
    nVox3D: W * H,
  } as unknown as NVImage
  // Centre at voxel (2000, 2): mm (c i - s j, s i + c j).
  const cx = c * 2000 - s * 2
  const cy = s * 2000 + c * 2
  const r = 1800.1
  const start = { x: cx - r, y: cy - r }
  const end = { x: cx + r, y: cy + r }
  const ann: VectorAnnotation = {
    ...annotation(generateShape('measureEllipse', start, end, 1)),
    shape: { type: 'measureEllipse', start, end },
  }
  expect(computeAnnotationStats(ann, rotated)?.min).toBe(-7)
})

test('isAreaGeometric: a self-crossing contour counts both lobes, as its voxel mask', () => {
  // Bowtie: two 25 mm^2 triangles whose signed shoelace parts cancel.
  const bowtie = [
    { x: 5, y: 5 },
    { x: 15, y: 15 },
    { x: 5, y: 15 },
    { x: 15, y: 5 },
  ]
  const ann: VectorAnnotation = {
    ...annotation(generatePolygonFromPoints(bowtie)),
    shape: { type: 'measureLivewire', start: bowtie[0], end: bowtie[3] },
  } as VectorAnnotation
  expect(computeAnnotationStats(ann, volume, true)?.area).toBeCloseTo(50, 6)
  expect(computeAnnotationStats(ann, volume)?.area).toBe(50)
})

test('an intact circle measures the square-constrained circle it draws', () => {
  // generateCircle squares (5,5)-(15,12) to (5,5)-(15,15): radius 5, centre (10,10).
  const start = { x: 5, y: 5 }
  const end = { x: 15, y: 12 }
  const ann: VectorAnnotation = {
    ...annotation(generateShape('measureCircle', start, end, 1)),
    shape: { type: 'measureCircle', start, end },
  }
  expect(computeAnnotationStats(ann, volume, true)?.area).toBeCloseTo(
    Math.PI * 25,
    6,
  )
  let inside = 0
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++)
      if ((i - 10) ** 2 + (j - 10) ** 2 <= 25) inside++
  expect(computeAnnotationStats(ann, volume)?.area).toBe(inside)
})

test('overlapping holes exclude their overlap once, in the mask and the geometric area', () => {
  // 10x10 outer at (0,0) with 5x5 holes at (2,2) and (4,4): 100 - 25 - 25 + 9.
  const ann = annotation([
    { outer: square(0, 0, 10), holes: [square(2, 2, 5), square(4, 4, 5)] },
  ])
  expect(computeAnnotationStats(ann, volume)?.area).toBe(59)
  expect(computeAnnotationStats(ann, volume, true)?.area).toBeCloseTo(59, 6)
})

test('overlapping pieces count their overlap once, in the mask and the geometric area', () => {
  // 5x5 pieces at (2,2) and (4,4): 25 + 25 - 9.
  const ann = annotation([
    { outer: square(2, 2, 5), holes: [] },
    { outer: square(4, 4, 5), holes: [] },
  ])
  expect(computeAnnotationStats(ann, volume)?.area).toBe(41)
  expect(computeAnnotationStats(ann, volume, true)?.area).toBeCloseTo(41, 6)
})
