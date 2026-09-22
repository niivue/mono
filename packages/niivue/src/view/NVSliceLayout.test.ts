import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { CustomLayoutTile, ViewHitTest } from '@/NVTypes'
import {
  type AxisWindowMM,
  cloneSliceTile,
  crosshairRadiusMM,
  everyTileWindowMM,
  fitSlicesAndGraph,
  projectMMToNearestTile,
  type SliceLayoutConfig,
  type SliceTile,
  screenSlicePick,
  screenSlicesLayout,
  slicePanUV,
  tileVisibleWindowMM,
  type VisibleWindowMM,
  visibleWindowMM,
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

  test('zeroInPlaneSpanKeepsAFiniteTile', () => {
    // Degenerate in-plane extents give an infinite fit scale. Filling by it
    // would put NaN mm bounds in the projection, and letterboxing to it is
    // 0 * Infinity: a NaN rect. With no aspect to fit, take the whole canvas.
    const over = {
      extentsMin: vec3.fromValues(0, 0, 0),
      extentsMax: vec3.fromValues(0, 0, 10),
    }
    for (const isSingleViewFillCanvas of [true, false]) {
      const [tile] = screenSlicesLayout(
        cfg({ ...over, isSingleViewFillCanvas }),
      )
      expect(tile.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
      const scr = tile.screen as { mnMM: vec3; mxMM: vec3 }
      for (const axis of [0, 1] as const) {
        expect(Number.isFinite(scr.mnMM[axis])).toBe(true)
        expect(Number.isFinite(scr.mxMM[axis])).toBe(true)
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

// ---------- visibleWindowMM ----------

// Deliberately asymmetric and anisotropic: equal spans or a centre on the
// origin hide a swapped U/V index and a dropped pan.
const EXTENTS_MIN = vec3.fromValues(-20, -5, -40)
const EXTENTS_MAX = vec3.fromValues(60, 25, 10)

const mpr = (over: Partial<SliceLayoutConfig> = {}): SliceLayoutConfig =>
  cfg({
    canvasWH: [800, 600],
    sliceType: NVConstants.SLICE_TYPE.MULTIPLANAR,
    extentsMin: EXTENTS_MIN,
    extentsMax: EXTENTS_MAX,
    ...over,
  })

const win = (w: VisibleWindowMM, axis: number): AxisWindowMM => {
  const got = w[axis]
  if (!got) throw new Error(`axis ${axis} has no visible window`)
  return got
}

describe('visibleWindowMM', () => {
  test('unpannedMultiplanarIsExactlyTheDataExtents', () => {
    const w = visibleWindowMM(screenSlicesLayout(mpr()))
    for (const axis of [0, 1, 2]) {
      expect(win(w, axis).minMM).toBeCloseTo(EXTENTS_MIN[axis], 9)
      expect(win(w, axis).maxMM).toBeCloseTo(EXTENTS_MAX[axis], 9)
    }
  })

  test('zoomNarrowsAboutTheCentreAndPanSlidesTheWindow', () => {
    const tiles = screenSlicesLayout(mpr())
    const plain = visibleWindowMM(tiles)
    const zoomed = visibleWindowMM(tiles, [0, 0, 0, 4])
    const panned = visibleWindowMM(tiles, [7, -3, 11, 4])
    for (const axis of [0, 1, 2]) {
      const p = win(plain, axis)
      const z = win(zoomed, axis)
      const centre = (p.minMM + p.maxMM) / 2
      expect(z.maxMM - z.minMM).toBeCloseTo((p.maxMM - p.minMM) / 4, 9)
      expect((z.minMM + z.maxMM) / 2).toBeCloseTo(centre, 9)
      // Pan is a world-mm offset of the window, so the span is untouched and
      // the centre moves by -pan.
      const q = win(panned, axis)
      expect(q.maxMM - q.minMM).toBeCloseTo(z.maxMM - z.minMM, 9)
      expect((q.minMM + q.maxMM) / 2).toBeCloseTo(centre - [7, -3, 11][axis], 9)
    }
  })

  test('radiologicalMirrorsTheScreenButNotTheWorldWindow', () => {
    // The convention negates the ortho bounds AND panU, so what is on screen
    // swaps sides while the mm interval it covers is identical. A helper that
    // "handled" radiological would be wrong here.
    const pan = [7, -3, 11, 2]
    const neuro = visibleWindowMM(screenSlicesLayout(mpr()), pan)
    const radio = visibleWindowMM(
      screenSlicesLayout(mpr({ isRadiologicalConvention: true })),
      pan,
    )
    expect(radio).toEqual(neuro)
  })

  test('matchesWhatTheMvpActuallyProjects', () => {
    // The claim the helper makes: its window edges are the edges of the tile.
    // Push them through the same matrix the renderer builds and they must land
    // on the clip-space border.
    const IDX = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 2, 0],
    ]
    for (const isRadiological of [false, true]) {
      const tiles = screenSlicesLayout(
        mpr({ isRadiologicalConvention: isRadiological }),
      )
      const pan = [7, -3, 11, 2.5]
      for (const tile of tiles) {
        const map = IDX[tile.axCorSag]
        if (!map) continue
        const w = tileVisibleWindowMM(tile, pan)
        if (!w) throw new Error('2D tile returned no window')
        const [mvp] = NVTransforms.calculateMvpMatrix2D(
          tile.leftTopWidthHeight as number[],
          Array.from((tile.screen as { mnMM: vec3 }).mnMM),
          Array.from((tile.screen as { mxMM: vec3 }).mxMM),
          Infinity,
          undefined,
          tile.azimuth as number,
          tile.elevation as number,
          isRadiological,
          undefined,
          undefined,
          slicePanUV(pan, tile.axCorSag),
        )
        const u = win(w, map[0])
        const v = win(w, map[1])
        // Depth mid-range keeps the sample inside near/far.
        const depth = (EXTENTS_MIN[map[2]] + EXTENTS_MAX[map[2]]) / 2
        for (const [uMM, vMM] of [
          [u.minMM, v.minMM],
          [u.maxMM, v.maxMM],
        ]) {
          const world = [0, 0, 0]
          world[map[0]] = uMM
          world[map[1]] = vMM
          world[map[2]] = depth
          const clip = vec4.create()
          vec4.transformMat4(
            clip,
            vec4.fromValues(world[0], world[1], world[2], 1),
            mvp,
          )
          expect(Math.abs(clip[0] / clip[3])).toBeCloseTo(1, 6)
          expect(Math.abs(clip[1] / clip[3])).toBeCloseTo(1, 6)
        }
      }
    }
  })

  test('depthOnlyAxesStayNull', () => {
    // A sagittal tile shows a plane at one X, not a range of X. Reporting a
    // zero-width window there would let a caller mistake it for a thin slab.
    const sag = mpr({
      sliceType: NVConstants.SLICE_TYPE.SAGITTAL,
      isSingleViewFillCanvas: false,
    })
    const w = visibleWindowMM(screenSlicesLayout(sag))
    expect(w[0]).toBeNull()
    expect(win(w, 1).minMM).toBeCloseTo(EXTENTS_MIN[1], 9)
    expect(win(w, 2).maxMM).toBeCloseTo(EXTENTS_MAX[2], 9)
  })

  test('reportsTheOrthoWindowNotTheData', () => {
    // A filled single view keeps the image scale and grows the window into the
    // margin, so the visible mm reach past the volume. Documented, and the
    // reason callers wanting the visible DATA have to intersect themselves.
    const sag = mpr({ sliceType: NVConstants.SLICE_TYPE.SAGITTAL })
    const boxed = visibleWindowMM(
      screenSlicesLayout({ ...sag, isSingleViewFillCanvas: false }),
    )
    const filled = visibleWindowMM(screenSlicesLayout(sag))
    // fillScreen rebuilds the bounds from a float32 centre, so compare with a
    // tolerance rather than exactly.
    const eps = 1e-4
    let widened = 0
    for (const axis of [1, 2]) {
      const f = win(filled, axis)
      const b = win(boxed, axis)
      expect(f.minMM).toBeLessThanOrEqual(b.minMM + eps)
      expect(f.maxMM).toBeGreaterThanOrEqual(b.maxMM - eps)
      // Centre holds: filling eats margin, it does not slide the image.
      expect((f.minMM + f.maxMM) / 2).toBeCloseTo((b.minMM + b.maxMM) / 2, 4)
      if (f.maxMM - f.minMM > b.maxMM - b.minMM + eps) widened++
    }
    // Only the axis with slack grows -- the other already spanned the pane.
    expect(widened).toBe(1)
  })

  test('skipsRenderGlobal3dAndScreenlessTiles', () => {
    const render = {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: [0, 0, 400, 400],
    } as unknown as SliceTile
    expect(tileVisibleWindowMM(render)).toBeNull()
    expect(visibleWindowMM([render])).toEqual([null, null, null])

    // Same tile, only `space` differs: without the flag it reports a window, so
    // this pins the skip rather than a tile that was empty anyway. The tile-level
    // entry has to refuse it too: its ortho window is in instance space, and a
    // caller reading those numbers as world mm cannot tell the difference.
    const canvasTile = screenSlicesLayout(mpr())[0]
    expect(tileVisibleWindowMM(canvasTile)).not.toBeNull()
    const global3d = { ...canvasTile, space: 'global3d' } as SliceTile
    expect(tileVisibleWindowMM(global3d)).toBeNull()
    expect(visibleWindowMM([global3d])).toEqual([null, null, null])

    expect(
      tileVisibleWindowMM({
        axCorSag: NVConstants.SLICE_TYPE.AXIAL,
      } as unknown as SliceTile),
    ).toBeNull()
  })

  test('degenerateZoomFallsBackToOneToOne', () => {
    // 0 or NaN would otherwise widen the window to infinity and poison any
    // bounds a caller derives from it.
    const tiles = screenSlicesLayout(mpr())
    const plain = visibleWindowMM(tiles)
    for (const zoom of [0, -1, Number.NaN]) {
      expect(visibleWindowMM(tiles, [0, 0, 0, zoom])).toEqual(plain)
    }
  })
})

// ---------- everyTileWindowMM ----------

describe('everyTileWindowMM', () => {
  type Screen = { mnMM: vec3; mxMM: vec3 }
  /** Copy of `tile` with its in-plane U ortho bounds shifted by `lo`/`hi`. */
  const withU = (tile: SliceTile, lo: number, hi: number): SliceTile => {
    const s = tile.screen as Screen
    const mnMM = vec3.clone(s.mnMM)
    const mxMM = vec3.clone(s.mxMM)
    mnMM[0] += lo
    mxMM[0] += hi
    return { ...tile, screen: { ...s, mnMM, mxMM } } as SliceTile
  }

  test('equalsTheUnionWhileEveryTileAgrees', () => {
    // Today's layouts give tiles sharing an axis the same window, so the two
    // reductions coincide; this is the tie the union's doc says not to rely on.
    const pan = [7, -3, 11, 2]
    for (const over of [{}, { isMultiplanarEqualSize: true }]) {
      const tiles = screenSlicesLayout(mpr(over))
      expect(everyTileWindowMM(tiles, pan)).toEqual(visibleWindowMM(tiles, pan))
    }
  })

  test('axesNoTileShowsStayNull', () => {
    const sag = mpr({
      sliceType: NVConstants.SLICE_TYPE.SAGITTAL,
      isSingleViewFillCanvas: false,
    })
    const w = everyTileWindowMM(screenSlicesLayout(sag))
    expect(w[0]).toBeNull()
    expect(win(w, 1).minMM).toBeCloseTo(EXTENTS_MIN[1], 9)
    expect(win(w, 2).maxMM).toBeCloseTo(EXTENTS_MAX[2], 9)
  })

  test('takesTheTightestWindowWhereTilesDisagree', () => {
    // Widen the axial tile's X window on both sides: the union grows with it,
    // the intersection keeps the coronal tile's narrower X, and Y/Z (which the
    // axial tile shares unchanged) are untouched.
    const tiles = screenSlicesLayout(mpr())
    const axial = tiles.findIndex((t) => t.axCorSag === 0)
    const wide = tiles.map((t, i) => (i === axial ? withU(t, -20, 30) : t))
    const pan = [7, -3, 11, 2]
    const plain = everyTileWindowMM(tiles, pan)
    const every = everyTileWindowMM(wide, pan)
    const union = visibleWindowMM(wide, pan)
    expect(every).toEqual(plain)
    expect(union[0]).not.toEqual(plain[0])
    expect(win(union, 0).minMM).toBeLessThan(win(plain, 0).minMM)
    expect(win(union, 0).maxMM).toBeGreaterThan(win(plain, 0).maxMM)
  })

  test('disjointWindowsLeaveTheAxisNull', () => {
    // Slide the axial tile's X window clear past the coronal tile's: no X is
    // visible in both, so there is no interval a follower could move to, and
    // an inverted one would have it chase one edge then the other.
    const tiles = screenSlicesLayout(mpr())
    const axial = tiles.findIndex((t) => t.axCorSag === 0)
    const apart = tiles.map((t, i) => (i === axial ? withU(t, 500, 500) : t))
    const w = everyTileWindowMM(apart)
    expect(w[0]).toBeNull()
    expect(w[1]).toEqual(win(everyTileWindowMM(tiles), 1))
    expect(w[2]).toEqual(win(everyTileWindowMM(tiles), 2))
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

  test('nonFiniteFitScaleKeepsAFiniteTile', () => {
    // Degenerate in-plane extents give an infinite fit scale: widening by it
    // would put NaN mm bounds in the projection, and letterboxing to it is
    // 0 * Infinity, a NaN rect. With no aspect to fit, both take the pane.
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
    expect(boxed.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
    expect(filled.leftTopWidthHeight).toEqual([0, 0, 2000, 400])
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

describe('cloneSliceTile', () => {
  test('nestedStateIsCopiedNotShared', () => {
    const tile = orthoAxialTile([0, 0, 100, 100], 0)
    tile.screen = {
      mnMM: vec3.fromValues(-50, -50, 0),
      mxMM: vec3.fromValues(50, 50, 0),
      fovMM: vec3.fromValues(100, 100, 0),
    }
    tile.crossLines = { axialMM: [1, 2], coronalMM: [3, 4], sagittalMM: [5, 6] }
    tile.pan = [7, 8]
    tile.globalCamera = { position: [1, 2, 3], yaw: 4 }
    const copy = cloneSliceTile(tile)

    expect(copy).toEqual(tile)
    expect(copy).not.toBe(tile)
    // a consumer writing into the copy must not reach the renderer's layout
    if (!copy.screen || !tile.screen || !copy.mvpMatrix || !tile.mvpMatrix)
      throw new Error('fixture lacks geometry')
    copy.screen.mnMM[0] = -999
    copy.leftTopWidthHeight?.splice(0, 1, 999)
    copy.mvpMatrix[0] = 999
    copy.crossLines?.axialMM.push(999)
    copy.pan?.splice(0, 1, 999)
    if (copy.globalCamera) copy.globalCamera.position[0] = 999
    expect(tile.screen.mnMM[0]).not.toBe(-999)
    expect(tile.leftTopWidthHeight?.[0]).toBe(0)
    expect(tile.mvpMatrix[0]).not.toBe(999)
    expect(tile.crossLines?.axialMM).toEqual([1, 2])
    expect(tile.pan).toEqual([7, 8])
    expect(tile.globalCamera?.position[0]).toBe(1)
  })
})
