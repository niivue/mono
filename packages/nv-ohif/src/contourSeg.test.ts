import { expect, test } from 'bun:test'
import type { NiiVue, VectorAnnotation } from '@niivue/niivue'
import { contourGroup, contourRois } from './contourSeg'

// A grid tilted 30 degrees about x: one axial voxel plane's mm depth varies
// with y, so a contour's z must be solved per point, not taken from its anchor.
test('RTSTRUCT contour points lie on the shape voxel plane, in LPS', () => {
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  // Row-major RAS voxel -> mm.
  const matRAS = [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]
  const at = [0, 2 * c - 3 * s, 2 * s + 3 * c] // voxel (0, 2, 3)
  const ring = [
    { x: 0, y: -4 },
    { x: 6, y: -4 },
    { x: 6, y: 8 },
  ]
  const shape = {
    id: 'a',
    group: contourGroup('s'),
    label: 1,
    sliceType: 0,
    slicePosition: at[2],
    anchorMM: at,
    polygons: [{ outer: ring, holes: [] }],
  } as unknown as VectorAnnotation
  const nv = {
    volumes: [
      {
        dimsRAS: [3, 10, 10, 10],
        img2RASstep: [1, 10, 100],
        img2RASstart: [0, 0, 0],
        matRAS,
      },
    ],
    annotations: [shape],
  } as unknown as NiiVue
  const [roi] = contourRois(nv, 's', [{ value: 1, label: 'S', rgb: [1, 2, 3] }])
  const data = roi?.contours[0]?.ContourData as number[]
  expect(data).toHaveLength(9)
  for (let i = 0; i < 3; i++) {
    const [x, y, z] = [
      -(data[3 * i] as number),
      -(data[3 * i + 1] as number),
      data[3 * i + 2] as number,
    ]
    expect(x).toBeCloseTo(ring[i]?.x as number, 4)
    expect(y).toBeCloseTo(ring[i]?.y as number, 4)
    // Voxel depth (row 2 of the inverse rotation) is the anchor's, 3.
    expect(-s * y + c * z).toBeCloseTo(3, 3)
  }
})
