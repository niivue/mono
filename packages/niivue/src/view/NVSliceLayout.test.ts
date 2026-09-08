import { describe, expect, test } from 'bun:test'
import { vec3 } from 'gl-matrix'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { CustomLayoutTile } from '@/NVTypes'
import {
  crosshairRadiusMM,
  fitSlicesAndGraph,
  type SliceLayoutConfig,
  type SliceTile,
  screenSlicesLayout,
} from './NVSliceLayout'

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
    const { screenSlices, graphWidth } = fitSlicesAndGraph(
      cfg({ isSingleViewFillCanvas: false }),
      base,
    )
    expect(screenSlices.length).toBeGreaterThanOrEqual(1)
    expect(graphWidth).toBeGreaterThan(base)
  })

  test('singleAxialFillingTheCanvas_leavesNoSlackToReclaim', () => {
    // The slack the graph used to take is now the slice's, so the graph keeps
    // its base width rather than both laying claim to the same pixels.
    const base = 200
    const { graphWidth } = fitSlicesAndGraph(cfg(), base)
    expect(graphWidth).toBe(base)
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

// Only the fields crosshairRadiusMM reads; the rest of NVModel is irrelevant to
// a unit conversion.
const chModel = (crosshairWidth: number, scaleMultiplier = 1): NVModel =>
  ({
    ui: { crosshairWidth },
    scene: { scaleMultiplier, pan2Dxyzmm: [0, 0, 0, 1] },
    furthestFromPivot: 100,
  }) as unknown as NVModel

const axialTile = (widthPx: number, mmAcross: number): SliceTile =>
  ({
    axCorSag: NVConstants.SLICE_TYPE.AXIAL,
    leftTopWidthHeight: [0, 0, widthPx, widthPx],
    screen: {
      mnMM: [-mmAcross / 2, -mmAcross / 2, 0],
      mxMM: [mmAcross / 2, mmAcross / 2, 0],
    },
  }) as unknown as SliceTile

describe('crosshairRadiusMM', () => {
  test('gives the world radius that subtends the requested pixel width', () => {
    // 180 mm across 360 px is 0.5 mm/px, so a 3 px thick crosshair is a
    // cylinder 1.5 mm across -- radius 0.75.
    expect(crosshairRadiusMM(chModel(3), axialTile(360, 180))).toBeCloseTo(
      0.75,
      6,
    )
  })

  test('holds the pixel weight as the field of view changes', () => {
    // The bug this replaces: one setting, wildly different thickness. A 2 mm
    // microscopy stack and a 1800 mm whole-body scan now agree on screen.
    const px = 400
    const tiny = crosshairRadiusMM(chModel(2), axialTile(px, 2))
    const huge = crosshairRadiusMM(chModel(2), axialTile(px, 1800))
    expect(tiny / 2).toBeCloseTo(huge / 1800, 9)
    expect(tiny).toBeCloseTo(0.005, 9)
  })

  test('shrinks with the 2D zoom so the crosshair does not thicken', () => {
    const tile = axialTile(360, 180)
    const zoomed = chModel(3)
    zoomed.scene.pan2Dxyzmm = [0, 0, 0, 3]
    expect(crosshairRadiusMM(zoomed, tile)).toBeCloseTo(
      crosshairRadiusMM(chModel(3), tile) / 3,
      9,
    )
  })

  test('scales with the render zoom on the 3D tile', () => {
    const renderTile = {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: [0, 0, 800, 500],
    } as unknown as SliceTile
    const plain = crosshairRadiusMM(chModel(4), renderTile)
    const zoomed = crosshairRadiusMM(chModel(4, 2), renderTile)
    // 0.8 * 100 mm across the 500 px short side, halved for a radius.
    expect(plain).toBeCloseTo((4 * ((2 * 80) / 500)) / 2, 9)
    expect(zoomed).toBeCloseTo(plain / 2, 9)
  })

  test('is 0 when the crosshair is off or the tile is degenerate', () => {
    expect(crosshairRadiusMM(chModel(0), axialTile(360, 180))).toBe(0)
    expect(crosshairRadiusMM(chModel(3), axialTile(0, 180))).toBe(0)
    // A tile with no screen bounds is a mosaic or global3d tile, which draws no
    // crosshair at all.
    expect(
      crosshairRadiusMM(chModel(3), {
        axCorSag: NVConstants.SLICE_TYPE.AXIAL,
        leftTopWidthHeight: [0, 0, 360, 360],
      } as unknown as SliceTile),
    ).toBe(0)
  })
})

describe('isSingleViewFillCanvas', () => {
  const mmPerPx = (t: SliceTile, axis: 0 | 1): number => {
    const s = t.screen as { mnMM: vec3; mxMM: vec3 }
    const ltwh = t.leftTopWidthHeight as number[]
    return (s.mxMM[axis] - s.mnMM[axis]) / ltwh[2 + axis]
  }
  const centre = (t: SliceTile, axis: 0 | 1): number => {
    const s = t.screen as { mnMM: vec3; mxMM: vec3 }
    return (s.mnMM[axis] + s.mxMM[axis]) / 2
  }

  test('off_letterboxesToTheSliceAspect', () => {
    const [tile] = screenSlicesLayout(cfg({ isSingleViewFillCanvas: false }))
    // Cube volume in a 2000x400 pane: a square tile centered horizontally.
    expect(tile.leftTopWidthHeight).toEqual([800, 0, 400, 400])
  })

  test('onTakesTheWholeCanvas', () => {
    const [tile] = screenSlicesLayout(cfg())
    expect(tile.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
  })

  test('fillingChangesNeitherTheScaleNorTheCentreOfTheSlice', () => {
    // The whole point: the slice lands on the same pixels either way. Only the
    // clipping rect grows, so a zoom eats the margin instead of the image.
    // Swept over all three orientations with ANISOTROPIC extents and both pane
    // aspects -- on a cube in a wide pane only axis 0 moves, so a swapped U/V
    // index in fillScreen would pass unnoticed.
    const extentsMax = vec3.fromValues(20, 10, 40)
    for (const sliceType of [0, 1, 2]) {
      for (const canvasWH of [
        [2000, 400],
        [400, 2000],
        [400, 400],
      ] as [number, number][]) {
        const over = { sliceType, canvasWH, extentsMax }
        const [boxed] = screenSlicesLayout(
          cfg({ ...over, isSingleViewFillCanvas: false }),
        )
        const [filled] = screenSlicesLayout(cfg(over))
        for (const axis of [0, 1] as const) {
          expect(mmPerPx(filled, axis)).toBeCloseTo(mmPerPx(boxed, axis), 10)
          expect(centre(filled, axis)).toBeCloseTo(centre(boxed, axis), 10)
        }
      }
    }
  })

  test('degenerateSliceAreaKeepsFiniteBounds', () => {
    // No room to fill: widening by the fit scale would be a divide by zero and
    // NaN mm bounds reach the projection matrix.
    for (const wh of [
      [0, 400],
      [-50, 400],
    ] as [number, number][]) {
      const [tile] = screenSlicesLayout(cfg({ canvasWH: wh }))
      const scr = tile.screen as { mnMM: vec3; mxMM: vec3; fovMM: vec3 }
      for (const axis of [0, 1]) {
        expect(Number.isFinite(scr.mnMM[axis])).toBe(true)
        expect(Number.isFinite(scr.mxMM[axis])).toBe(true)
        expect(scr.mxMM[axis]).toBeGreaterThan(scr.mnMM[axis])
      }
    }
  })

  test('multiplanarIgnoresTheFlag', () => {
    const off = screenSlicesLayout(
      cfg({ sliceType: 3, isSingleViewFillCanvas: false }),
    )
    const on = screenSlicesLayout(cfg({ sliceType: 3 }))
    expect(on.map((t) => t.leftTopWidthHeight)).toEqual(
      off.map((t) => t.leftTopWidthHeight),
    )
  })
})

describe('customLayout tile fill', () => {
  const mmPerPx = (t: SliceTile, axis: 0 | 1): number => {
    const s = t.screen as { mnMM: vec3; mxMM: vec3 }
    const ltwh = t.leftTopWidthHeight as number[]
    return (s.mxMM[axis] - s.mnMM[axis]) / ltwh[2 + axis]
  }
  const centre = (t: SliceTile, axis: 0 | 1): number => {
    const s = t.screen as { mnMM: vec3; mxMM: vec3 }
    return (s.mnMM[axis] + s.mxMM[axis]) / 2
  }
  const axialPane = (
    over: Partial<CustomLayoutTile> = {},
  ): CustomLayoutTile[] => [{ sliceType: 0, position: [0, 0, 1, 1], ...over }]

  test('absentFlag_letterboxesToTheSliceAspect', () => {
    // Byte-identical to the pre-fill behaviour: a cube in a 2000x400 pane is a
    // square tile centered horizontally, mm window equal to the data's.
    for (const layout of [axialPane(), axialPane({ fill: false })]) {
      const [tile] = screenSlicesLayout(cfg({ customLayout: layout }))
      expect(tile.leftTopWidthHeight).toEqual([800, 0, 400, 400])
      const s = tile.screen as { mnMM: vec3; mxMM: vec3; fovMM: vec3 }
      for (const axis of [0, 1] as const) {
        expect(s.mxMM[axis] - s.mnMM[axis]).toBeCloseTo(s.fovMM[axis], 10)
      }
    }
  })

  test('filledTileOccupiesItsWholePaneRect', () => {
    const [full] = screenSlicesLayout(
      cfg({ customLayout: axialPane({ fill: true }) }),
    )
    expect(full.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
    // A sub-pane tile fills its own rect, not the canvas.
    const [half] = screenSlicesLayout(
      cfg({
        customLayout: [
          { sliceType: 0, position: [0.25, 0, 0.5, 1], fill: true },
        ],
      }),
    )
    expect(half.leftTopWidthHeight).toEqual([500, 0, 1000, 400])
  })

  test('fillingWidensTheWindowAboutItsCentre_fovStaysTheData', () => {
    // Same pin as the single-view path: the slice lands on identical pixels,
    // only the clipping rect grows. Anisotropic extents so a swapped U/V index
    // in fillScreen would not pass unnoticed.
    const extentsMax = vec3.fromValues(20, 10, 40)
    for (const sliceType of [0, 1, 2]) {
      for (const canvasWH of [
        [2000, 400],
        [400, 2000],
        [400, 400],
      ] as [number, number][]) {
        const over = { canvasWH, extentsMax }
        const pane = (fill: boolean): CustomLayoutTile[] => [
          { sliceType, position: [0, 0, 1, 1], fill },
        ]
        const [boxed] = screenSlicesLayout(
          cfg({ ...over, customLayout: pane(false) }),
        )
        const [filled] = screenSlicesLayout(
          cfg({ ...over, customLayout: pane(true) }),
        )
        const boxedScr = boxed.screen as { fovMM: vec3 }
        const filledScr = filled.screen as { fovMM: vec3 }
        for (const axis of [0, 1] as const) {
          expect(mmPerPx(filled, axis)).toBeCloseTo(mmPerPx(boxed, axis), 10)
          expect(centre(filled, axis)).toBeCloseTo(centre(boxed, axis), 10)
          // fovMM stays the DATA's span; only mnMM/mxMM widen.
          expect(filledScr.fovMM[axis]).toBeCloseTo(boxedScr.fovMM[axis], 10)
        }
      }
    }
  })

  test('nonFiniteFitScaleFallsBackToLetterbox', () => {
    // Degenerate in-plane extents give an infinite fit scale; widening by it
    // would put NaN mm bounds in the projection matrix.
    const over = {
      extentsMin: vec3.fromValues(0, 0, 0),
      extentsMax: vec3.fromValues(0, 0, 10),
    }
    const [boxed] = screenSlicesLayout(
      cfg({ ...over, customLayout: axialPane() }),
    )
    const [filled] = screenSlicesLayout(
      cfg({ ...over, customLayout: axialPane({ fill: true }) }),
    )
    const boxedScr = boxed.screen as { mnMM: vec3; mxMM: vec3 }
    const filledScr = filled.screen as { mnMM: vec3; mxMM: vec3 }
    for (const axis of [0, 1] as const) {
      expect(Number.isFinite(filledScr.mnMM[axis])).toBe(true)
      expect(Number.isFinite(filledScr.mxMM[axis])).toBe(true)
      expect(filledScr.mnMM[axis]).toBe(boxedScr.mnMM[axis])
      expect(filledScr.mxMM[axis]).toBe(boxedScr.mxMM[axis])
    }
  })

  test('renderTileIgnoresTheFlag', () => {
    // RENDER tiles already take their whole rect; the flag must not disturb them.
    const [tile] = screenSlicesLayout(
      cfg({
        customLayout: [{ sliceType: 4, position: [0, 0, 1, 1], fill: true }],
      }),
    )
    expect(tile.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
    expect(tile.screen).toBeUndefined()
  })
})
