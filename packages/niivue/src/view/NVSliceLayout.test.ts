import { describe, expect, test } from 'bun:test'
import { mat4, vec3 } from 'gl-matrix'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { ViewHitTest } from '@/NVTypes'
import {
  crosshairRadiusMM,
  fitSlicesAndGraph,
  projectMMToNearestTile,
  type SliceLayoutConfig,
  type SliceTile,
  screenSlicePick,
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

// ---------- Screen-space projection (external overlay API) ----------

// An axis-aligned axial tile with a hand-built orthographic MVP: world x/y in
// [-50, 50] mm map linearly onto the tile rect, the slice plane is z = zMM.
// This mirrors what the renderer caches on a SliceTile after a draw
// (mvpMatrix + planeNormal + planePoint), without needing a GPU.
function orthoAxialTile(ltwh: number[], zMM: number): SliceTile {
  const mvp = mat4.create()
  mat4.ortho(mvp, -50, 50, -50, 50, -50, 50)
  return {
    axCorSag: NVConstants.SLICE_TYPE.AXIAL,
    leftTopWidthHeight: ltwh,
    mvpMatrix: mvp,
    planeNormal: vec3.fromValues(0, 0, 1),
    planePoint: vec3.fromValues(0, 0, zMM),
  }
}

// Only the fields screenSlicePick's fast path reads.
const pickModel = () =>
  ({ volumes: [{}], tex2mm: mat4.create() }) as unknown as NVModel

const axialHit = (tileIndex: number): ViewHitTest => ({
  tileIndex,
  isRender: false,
  sliceType: NVConstants.SLICE_TYPE.AXIAL,
  normalizedX: 0,
  normalizedY: 0,
})

describe('projectMMToNearestTile', () => {
  test('roundTripsWithScreenSlicePick', () => {
    // canvas -> mm (the crosshair pick path) -> canvas must land on the pixel
    // it started from, on the same tile.
    const tile = orthoAxialTile([10, 20, 200, 160], 7)
    const canvasX = 55
    const canvasY = 60
    const mm = screenSlicePick(
      [tile],
      pickModel(),
      canvasX,
      canvasY,
      axialHit(0),
    )
    expect(mm).not.toBeNull()
    if (!mm) return
    expect(mm[2]).toBeCloseTo(7, 5) // picked point lies on the slice plane
    const proj = projectMMToNearestTile([tile], mm)
    expect(proj).not.toBeNull()
    if (!proj) return
    expect(proj.tileIndex).toBe(0)
    expect(proj.x).toBeCloseTo(canvasX, 5)
    expect(proj.y).toBeCloseTo(canvasY, 5)
  })

  test('picksTheTileWhoseSlicePlaneIsNearest', () => {
    const tiles = [
      orthoAxialTile([0, 0, 100, 100], 0),
      orthoAxialTile([100, 0, 100, 100], 20),
    ]
    expect(projectMMToNearestTile(tiles, [0, 0, 2])?.tileIndex).toBe(0)
    expect(projectMMToNearestTile(tiles, [0, 0, 19])?.tileIndex).toBe(1)
  })

  test('tieResolvesToTheLowestTileIndex', () => {
    const tiles = [
      orthoAxialTile([0, 0, 100, 100], 5),
      orthoAxialTile([100, 0, 100, 100], 5),
    ]
    expect(projectMMToNearestTile(tiles, [1, 2, 5])?.tileIndex).toBe(0)
  })

  test('skipsRenderTilesAndTilesWithoutCachedGeometry', () => {
    const render = orthoAxialTile([0, 0, 100, 100], 0)
    render.axCorSag = NVConstants.SLICE_TYPE.RENDER
    const bare: SliceTile = {
      axCorSag: NVConstants.SLICE_TYPE.AXIAL,
      leftTopWidthHeight: [0, 0, 100, 100],
      // no mvpMatrix/planeNormal/planePoint: pre-first-render tile
    }
    expect(projectMMToNearestTile([render, bare], [0, 0, 0])).toBeNull()
    const slice = orthoAxialTile([100, 0, 100, 100], 0)
    expect(
      projectMMToNearestTile([render, bare, slice], [0, 0, 0])?.tileIndex,
    ).toBe(2)
  })

  test('projectsOutsideTheTileRectWhenThePointIsOutOfView', () => {
    const tile = orthoAxialTile([0, 0, 100, 100], 0)
    // x = 75mm is beyond the tile's +-50mm window: documented to project
    // outside the rect rather than clamp.
    const proj = projectMMToNearestTile([tile], [75, 0, 0])
    expect(proj).not.toBeNull()
    if (!proj) return
    expect(proj.x).toBeGreaterThan(100)
  })
})
