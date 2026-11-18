import { expect, it } from 'bun:test'
import { largestBidirectional } from './segBidirectional'

// A cross of segment 1 on slice 1 of a 9x9x2 grid (1 mm voxels): the major
// is the horizontal bar, the minor the vertical one. Segment 2's longer
// diagonal on slice 0 must not count.
it('largest bidirectional: farthest pair, then widest perpendicular chord', () => {
  const img = new Uint8Array(9 * 9 * 2)
  for (let i = 0; i < 9; i++) img[i + 9 * i] = 2
  for (let x = 0; x < 9; x++) img[81 + x + 9 * 4] = 1
  for (let y = 2; y <= 6; y++) img[81 + 4 + 9 * y] = 1
  const ends = largestBidirectional(img, [9, 9, 2], (v) => v, 1, 2)
  expect(ends).toEqual([
    [0, 4, 1],
    [8, 4, 1],
    [4, 2, 1],
    [4, 6, 1],
  ])
  expect(largestBidirectional(img, [9, 9, 2], (v) => v, 3, 2)).toBeUndefined()
})

// A volume origin off a multiple of the slice step keeps the endpoints on
// their voxel-centre plane.
it('largest bidirectional: slabs follow the volume origin', () => {
  const img = new Uint8Array(8).fill(1)
  const ends = largestBidirectional(
    img,
    [2, 2, 2],
    ([x, y, z]) => [x, y, 1 + 2 * z],
    1,
    2,
  )
  for (const p of ends ?? []) expect([1, 3]).toContain(p[2])
  expect(ends).toBeDefined()
})

// A slice step thinner than the pixels must not bin the major by it: the L's
// short diameter is one pixel, not zero.
it('largest bidirectional: binned by the in-plane step', () => {
  const img = new Uint8Array(4)
  img[0] = img[1] = img[2] = 1
  const ends = largestBidirectional(
    img,
    [2, 2, 1],
    ([x, y, z]) => [x, y, z * 0.1],
    1,
    2,
  )
  const [, , c, d] = ends ?? []
  expect(c && d && Math.hypot(c[0] - d[0], c[1] - d[1])).toBe(1)
})

// Review of #863: on an oblique anisotropic grid (spacing 1,1,5; 20 degree
// tilt about y) projecting surface voxels onto the world plane put the major
// endpoints outside the segment (nearest voxels (8,2,1), (8,12,1): label 0).
it('largest bidirectional keeps every endpoint inside an oblique segment', () => {
  const n = 15
  const img = new Uint8Array(n * n * 3)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if ((x - 7) ** 2 + (y - 7) ** 2 <= 25) img[x + n * (y + n)] = 1
  const c = Math.cos(Math.PI / 9)
  const s = Math.sin(Math.PI / 9)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [c * x - 5 * s * z, y, s * x + 5 * c * z]
  const ends = largestBidirectional(img, [n, n, 3], vox2mm, 1, 2)
  expect(ends).toBeDefined()
  for (const [x, y, z] of ends ?? []) {
    const [i, j, k] = [c * x + s * z, y, (-s * x + c * z) / 5].map(
      Math.round,
    ) as [number, number, number]
    expect(img[i + n * (j + n * k)]).toBe(1)
  }
})

// Review of #863: a three-voxel line tilted 10 degrees gives each world plane
// one sample at the voxel step, so no plane had a major axis.
it('largest bidirectional finds a thin oblique segment', () => {
  const n = 7
  const img = new Uint8Array(n * n * n)
  for (let x = 2; x <= 4; x++) img[x + n * (3 + n * 3)] = 1
  const c = Math.cos(Math.PI / 18)
  const s = Math.sin(Math.PI / 18)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [c * x - s * z, y, s * x + c * z]
  expect(largestBidirectional(img, [n, n, n], vox2mm, 1, 2)).toBeDefined()
})

// Review of #863: a grid sampled along world axes shortened an ellipse rotated
// in-plane (17.09 x 10.77) and grew one end on anisotropic pixels (12.5).
it.each([
  ['rotated 30 degrees in-plane', Math.PI / 6, 1, [18, 12]],
  ['0.5 x 1 mm pixels', 0, 0.5, [12, 9]],
] as const)('largest bidirectional is exact on a grid %s', (_, angle, sx, want) => {
  const n = 30
  const img = new Uint8Array(n * n * 10)
  for (let z = 0; z < 10; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (((x - 14) / 9) ** 2 + ((y - 15) / 6) ** 2 + ((z - 5) / 4) ** 2 <= 1)
          img[x + n * (y + n * z)] = 1
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [c * sx * x - s * y, s * sx * x + c * y, 3 * z]
  const [a, b, d, e] = largestBidirectional(img, [n, n, 10], vox2mm, 1, 2) ?? []
  const len = (
    p?: readonly [number, number, number],
    q?: readonly [number, number, number],
  ) =>
    p && q ? Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]) * 100) / 100 : 0
  expect([len(a, b), len(d, e)]).toEqual([...want])
})

// Review of #863: on an oblique grid a voxel's cell reaches past half a step,
// so a grid padded by half a step clipped a one-slice segment (3.22 mm).
it('largest bidirectional samples whole cells on an oblique grid', () => {
  const n = 40
  const img = new Uint8Array(n * n * 30)
  for (let z = 0; z < 30; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (
          ((x - 15.5) / 3) ** 2 + ((y - 20) / 2) ** 2 + ((z - 10) / 0.6) ** 2 <=
          1
        )
          img[x + n * (y + n * z)] = 1
  const c = Math.cos(Math.PI / 3)
  const s = Math.sin(Math.PI / 3)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [0.8 * c * x + 5 * s * z, 0.8 * y, -0.8 * s * x + 5 * c * z]
  const [a, b] = largestBidirectional(img, [n, n, 30], vox2mm, 1, 2) ?? []
  expect(a && b && Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(5.44, 2)
})

// Review of #863: a sheared affine projected the in-plane columns parallel
// onto the sagittal plane, so a filled block gave no measurement, then a
// zero minor (one sample per chord bin).
it('largest bidirectional measures on a sheared grid', () => {
  const img = new Uint8Array(27).fill(1)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [2 * x + y + z, y + 2 * z, x]
  const [, , c, d] = largestBidirectional(img, [3, 3, 3], vox2mm, 1, 0) ?? []
  expect(
    c && d && Math.hypot(c[0] - d[0], c[1] - d[1], c[2] - d[2]),
  ).toBeGreaterThan(0)
})

// Review of 0c96b432: on an aligned grid with unequal pixels (1 x 2 mm) the
// grid stepped both axes by 1 mm, sampling outside the voxel centres: a 2x2
// block measured sqrt(10), not its centres' diagonal sqrt(5).
it('largest bidirectional samples voxel centres on unequal pixels', () => {
  const ends = largestBidirectional(
    new Uint8Array(4).fill(1),
    [2, 2, 1],
    ([x, y, z]) => [x, 2 * y, z],
    1,
    2,
  )
  const [a, b] = ends ?? []
  expect(a && b && Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(
    Math.sqrt(5),
    6,
  )
})
