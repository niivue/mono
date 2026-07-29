import { describe, expect, test } from 'bun:test'
import { drawingSliceToSVG } from './drawingSvg'

// 4x4x4 drawing bitmap; helper to set a voxel by RAS ijk.
const DIMS = [3, 4, 4, 4]
const flat = (x: number, y: number, z: number) => x + y * 4 + z * 16
const red = () => '#ff0000'

describe('drawingSliceToSVG', () => {
  test('emits a run-length rect for a painted horizontal run on the axial slice', () => {
    const bmp = new Uint8Array(64)
    // Row y=1 at z=2: x=1,2,3 painted label 1 (a run of 3).
    bmp[flat(1, 1, 2)] = 1
    bmp[flat(2, 1, 2)] = 1
    bmp[flat(3, 1, 2)] = 1
    const svg = drawingSliceToSVG({
      bitmap: bmp,
      dims: DIMS,
      sliceAxis: 2, // axial: plane (x,y), fixed z
      sliceIndex: 2,
      colorForLabel: red,
    })
    expect(svg).toContain('viewBox="0 0 4 4"')
    expect(svg).toContain(
      '<rect x="1" y="1" width="3" height="1" fill="#ff0000" />',
    )
    // exactly one rect
    expect(svg.match(/<rect /g)?.length).toBe(1)
  })

  test('breaks runs at a label change and colors per label', () => {
    const bmp = new Uint8Array(64)
    bmp[flat(0, 0, 0)] = 1
    bmp[flat(1, 0, 0)] = 2 // different label -> separate rect
    const svg = drawingSliceToSVG({
      bitmap: bmp,
      dims: DIMS,
      sliceAxis: 2,
      sliceIndex: 0,
      colorForLabel: (l) => (l === 1 ? '#111111' : '#222222'),
    })
    expect(svg).toContain(
      '<rect x="0" y="0" width="1" height="1" fill="#111111" />',
    )
    expect(svg).toContain(
      '<rect x="1" y="0" width="1" height="1" fill="#222222" />',
    )
    expect(svg.match(/<rect /g)?.length).toBe(2)
  })

  test('skips label 0 and null-colored labels', () => {
    const bmp = new Uint8Array(64)
    bmp[flat(0, 0, 0)] = 5 // colorForLabel returns null -> skipped
    const svg = drawingSliceToSVG({
      bitmap: bmp,
      dims: DIMS,
      sliceAxis: 2,
      sliceIndex: 0,
      colorForLabel: () => null,
    })
    expect(svg.match(/<rect /g)).toBeNull()
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })

  test('coronal slice uses the (x,z) plane', () => {
    const bmp = new Uint8Array(64)
    // fixed y=3; paint x=2, z=1.
    bmp[flat(2, 3, 1)] = 1
    const svg = drawingSliceToSVG({
      bitmap: bmp,
      dims: DIMS,
      sliceAxis: 1, // coronal: plane (x,z)
      sliceIndex: 3,
      colorForLabel: red,
    })
    // column = x = 2, row = z = 1
    expect(svg).toContain('<rect x="2" y="1" width="1" height="1"')
  })

  test('out-of-range slice index yields a valid empty SVG', () => {
    const bmp = new Uint8Array(64)
    bmp[flat(0, 0, 0)] = 1
    const svg = drawingSliceToSVG({
      bitmap: bmp,
      dims: DIMS,
      sliceAxis: 2,
      sliceIndex: 99,
      colorForLabel: red,
    })
    expect(svg.match(/<rect /g)).toBeNull()
    expect(svg).toContain('<svg')
  })
})
