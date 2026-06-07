import { describe, expect, test } from 'bun:test'
import { vec3 } from 'gl-matrix'
import { fitSlicesAndGraph, type SliceLayoutConfig } from './NVSliceLayout'

// Wide pane (2000x400) with a cube volume: a single-orientation slice is ~square
// (~400 wide), leaving large horizontal slack the graph should reclaim.
function cfg(over: Partial<SliceLayoutConfig> = {}): SliceLayoutConfig {
  return {
    canvasWH: [2000, 400],
    extentsMin: vec3.fromValues(0, 0, 0),
    extentsMax: vec3.fromValues(10, 10, 10),
    sliceType: 0, // axial
    ...over,
  }
}

describe('fitSlicesAndGraph', () => {
  test('singleAxial_graphReclaimsHorizontalSlack', () => {
    const base = 200
    const { screenSlices, graphWidth } = fitSlicesAndGraph(cfg(), base)
    expect(screenSlices.length).toBeGreaterThanOrEqual(1)
    expect(graphWidth).toBeGreaterThan(base)
  })

  test('noGraph_returnsZeroWidthAndUnchangedSlices', () => {
    const { graphWidth } = fitSlicesAndGraph(cfg(), 0)
    expect(graphWidth).toBe(0)
  })

  test('multiplanar_keepsBaseGraphWidth', () => {
    // Grids can reflow on width change, so they are left at the base width.
    const base = 200
    const { graphWidth } = fitSlicesAndGraph(cfg({ sliceType: 3 }), base)
    expect(graphWidth).toBe(base)
  })

  test('mosaic_keepsBaseGraphWidth', () => {
    const base = 200
    const { graphWidth } = fitSlicesAndGraph(
      cfg({ sliceMosaicString: 'A 0 S 0' }),
      base,
    )
    expect(graphWidth).toBe(base)
  })
})
