import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import NiiVue from '@/index'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { CustomLayoutTile, Rotation2D, ViewHitTest } from '@/NVTypes'
import {
  type AxisWindowMM,
  cloneSliceTile,
  crosshairRadiusMM,
  everyTileWindowMM,
  fitSlicesAndGraph,
  fitSlicesFromModel,
  insetRect,
  isSliceMirrored,
  projectMMToNearestTile,
  projectMMToRenderTile,
  type SliceLayoutConfig,
  type SliceOrientationSettings,
  type SliceTile,
  sagittalNoseLeft,
  screenSlicePick,
  screenSlicesLayout,
  slicePanUV,
  sliceRotation,
  tileVisibleWindowMM,
  type VisibleWindowMM,
  visibleWindowMM,
} from './NVSliceLayout'
import { projectMMToCanvas } from './sliceUtils'

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

describe('projectMMToRenderTile', () => {
  // A perspective render tile whose camera sits 100 mm down +z looking at the
  // origin, so a point's screen position depends on its depth (the w divide).
  function renderTile(ltwh: number[]): SliceTile {
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 1000)
    const view = mat4.lookAt(
      mat4.create(),
      vec3.fromValues(0, 0, 100),
      vec3.fromValues(0, 0, 0),
      vec3.fromValues(0, 1, 0),
    )
    return {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: ltwh,
      mvpMatrix: mat4.multiply(mat4.create(), proj, view),
    }
  }

  test('mapsTheLookAtPointToTheTileCentreAndDividesByW', () => {
    const tile = renderTile([100, 50, 200, 200])
    const centre = projectMMToRenderTile([tile], [0, 0, 0])
    expect(centre).not.toBeNull()
    if (!centre) return
    expect(centre[0]).toBeCloseTo(200, 5)
    expect(centre[1]).toBeCloseTo(150, 5)
    // +y in mm is up on screen (smaller canvas y); a point at half the camera
    // distance projects twice as far from the centre as one at full distance.
    const near = projectMMToRenderTile([tile], [10, 10, 50])
    const far = projectMMToRenderTile([tile], [10, 10, 0])
    expect(near).not.toBeNull()
    expect(far).not.toBeNull()
    if (!near || !far) return
    expect(far[1]).toBeLessThan(150)
    expect(near[0] - 200).toBeCloseTo(2 * (far[0] - 200), 5)
    expect(150 - near[1]).toBeCloseTo(2 * (150 - far[1]), 5)
  })

  test('returnsNullWithoutADrawnRenderTileOrBehindTheCamera', () => {
    expect(projectMMToRenderTile([], [0, 0, 0])).toBeNull()
    expect(
      projectMMToRenderTile([orthoAxialTile([0, 0, 100, 100], 0)], [0, 0, 0]),
    ).toBeNull()
    const bare: SliceTile = {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: [0, 0, 100, 100],
    }
    expect(projectMMToRenderTile([bare], [0, 0, 0])).toBeNull()
    const tile = renderTile([0, 0, 100, 100])
    expect(projectMMToRenderTile([tile], [0, 0, 200])).toBeNull()
  })

  test('skipsSliceTilesToFindTheRenderTile', () => {
    const slice = orthoAxialTile([0, 0, 100, 100], 0)
    const tile = renderTile([100, 0, 100, 100])
    const p = projectMMToRenderTile([slice, tile], [0, 0, 0])
    expect(p).not.toBeNull()
    if (!p) return
    expect(p[0]).toBeCloseTo(150, 5)
    expect(p[1]).toBeCloseTo(50, 5)
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

describe('layout inset', () => {
  test('insetRectScalesByDprAndClamps', () => {
    expect(insetRect(800, 600, [100, 10, 0, 20], 2)).toEqual([
      200, 20, 600, 540,
    ])
    // Bad sides count as 0; a too-large inset leaves at least 1 px.
    expect(insetRect(800, 600, [Number.NaN, -5, 0, 0], 1)).toEqual([
      0, 0, 800, 600,
    ])
    expect(insetRect(100, 100, [500, 0, 500, 0], 1)).toEqual([99, 0, 1, 100])
    // A 0 px canvas leaves nothing, and x/y stay inside it.
    expect(insetRect(0, 0, [10, 10, 0, 0], 1)).toEqual([0, 0, 0, 0])
  })

  test('normalizeInsetKeepsFourFiniteNonNegativeSides', () => {
    expect(NVConstants.normalizeInset([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
    expect(NVConstants.normalizeInset(null)).toEqual([0, 0, 0, 0])
    expect(NVConstants.normalizeInset([Number.NaN, -1, 5])).toEqual([
      0, 0, 5, 0,
    ])
  })

  test('fitSlicesFromModelShiftsTilesToTheOrigin', () => {
    const model = {
      isSpatialViewHidden: () => false,
      layout: {
        ...NVConstants.LAYOUT_DEFAULTS,
        sliceType: NVConstants.SLICE_TYPE.AXIAL,
      },
      ui: { isCrossLinesVisible: false },
      extentsMin: [-10, -10, -10],
      extentsMax: [10, 10, 10],
    } as unknown as NVModel
    const plain = fitSlicesFromModel(model, [400, 300], 0).screenSlices
    const moved = fitSlicesFromModel(
      model,
      [400, 300],
      0,
      [150, 20],
    ).screenSlices
    const [l, t, w, h] = plain[0]?.leftTopWidthHeight ?? []
    expect(moved[0]?.leftTopWidthHeight).toEqual([l + 150, t + 20, w, h])
  })
})

// ---------- isSagittalNoseLeft ----------

// The four combinations AFNI can ask for, plus the unset default that must keep
// following isRadiological so existing scenes render identically.
const NOSE_CASES: {
  isRadiological: boolean
  isSagittalNoseLeft: boolean | null
  noseLeft: boolean
}[] = [
  { isRadiological: false, isSagittalNoseLeft: null, noseLeft: false },
  { isRadiological: true, isSagittalNoseLeft: null, noseLeft: true },
  { isRadiological: false, isSagittalNoseLeft: false, noseLeft: false },
  { isRadiological: false, isSagittalNoseLeft: true, noseLeft: true },
  { isRadiological: true, isSagittalNoseLeft: false, noseLeft: false },
  { isRadiological: true, isSagittalNoseLeft: true, noseLeft: true },
]

const SAG = NVConstants.SLICE_TYPE.SAGITTAL

describe('isSagittalNoseLeft', () => {
  test('unsetFollowsIsRadiological', () => {
    expect(sagittalNoseLeft({ isRadiological: false })).toBe(false)
    expect(sagittalNoseLeft({ isRadiological: true })).toBe(true)
    expect(
      sagittalNoseLeft({ isRadiological: true, isSagittalNoseLeft: null }),
    ).toBe(true)
  })

  test('sagittalRotationAndMirrorFollowTheNoseOnly', () => {
    for (const c of NOSE_CASES) {
      expect(sagittalNoseLeft(c)).toBe(c.noseLeft)
      expect(sliceRotation(SAG, c)).toEqual({
        azimuth: c.noseLeft ? 90 : -90,
        elevation: 0,
      })
      expect(isSliceMirrored(SAG, c)).toBe(c.noseLeft)
    }
  })

  test('axialAndCoronalIgnoreTheNose', () => {
    for (const c of NOSE_CASES) {
      const plain = { isRadiological: c.isRadiological }
      for (const t of [
        NVConstants.SLICE_TYPE.AXIAL,
        NVConstants.SLICE_TYPE.CORONAL,
      ]) {
        expect(sliceRotation(t, c)).toEqual(sliceRotation(t, plain))
        expect(isSliceMirrored(t, c)).toBe(c.isRadiological)
      }
    }
  })

  test('everyLayoutPathOrientsSagittalTilesByTheNose', () => {
    const paths: Partial<SliceLayoutConfig>[] = [
      {}, // multiplanar
      { sliceType: SAG }, // single view
      { heroImageFraction: 0.5, heroSliceType: SAG }, // hero
      { isMultiplanarEqualSize: true },
      { sliceMosaicString: 'S 0 10' },
      { customLayout: [{ sliceType: SAG, position: [0, 0, 1, 1] }] },
    ]
    for (const path of paths) {
      for (const c of NOSE_CASES) {
        const tiles = screenSlicesLayout(
          mpr({
            ...path,
            isRadiologicalConvention: c.isRadiological,
            isSagittalNoseLeft: c.isSagittalNoseLeft,
          }),
        ).filter((t) => t.axCorSag === SAG)
        expect(tiles.length).toBeGreaterThan(0)
        for (const t of tiles) {
          expect(t.azimuth).toBe(c.noseLeft ? 90 : -90)
        }
      }
    }
  })

  test('unsetIsByteIdenticalToTheRadiologicalOnlyLayout', () => {
    for (const isRadiologicalConvention of [false, true]) {
      const before = screenSlicesLayout(mpr({ isRadiologicalConvention }))
      const after = screenSlicesLayout(
        mpr({ isRadiologicalConvention, isSagittalNoseLeft: null }),
      )
      expect(after).toEqual(before)
    }
  })

  test('noseIsDrawnWhereItSaysAndPickingLandsWhereYouClick', () => {
    // The tile azimuth and the mirror flag are two halves of one decision:
    // the tile window must project onto the clip border (nothing drawn
    // off-screen), anterior must land on the side the setting names, and the
    // pick fallback (no cached MVP) must invert the same projection.
    for (const c of NOSE_CASES) {
      const layout = {
        isRadiological: c.isRadiological,
        isSagittalNoseLeft: c.isSagittalNoseLeft,
      }
      const [tile] = screenSlicesLayout(
        mpr({
          sliceType: SAG,
          isSingleViewFillCanvas: false,
          isRadiologicalConvention: c.isRadiological,
          isSagittalNoseLeft: c.isSagittalNoseLeft,
        }),
      )
      const ltwh = tile.leftTopWidthHeight as number[]
      const screen = tile.screen as { mnMM: vec3; mxMM: vec3 }
      const [mvp] = NVTransforms.calculateMvpMatrix2D(
        ltwh,
        Array.from(screen.mnMM),
        Array.from(screen.mxMM),
        tile.azimuth as number,
        tile.elevation as number,
        isSliceMirrored(SAG, layout),
      )
      const clipX = (y: number): number => {
        const out = vec4.create()
        vec4.transformMat4(out, vec4.fromValues(0, y, 0, 1), mvp)
        return out[0] / out[3]
      }
      // The anterior edge (+Y max) sits at -1 (left) when the nose is left.
      expect(clipX(EXTENTS_MAX[1])).toBeCloseTo(c.noseLeft ? -1 : 1, 6)
      expect(clipX(EXTENTS_MIN[1])).toBeCloseTo(c.noseLeft ? 1 : -1, 6)

      const model = {
        volumes: [{}],
        tex2mm: mat4.create(),
        layout,
        scene: { pan2Dxyzmm: [0, 0, 0, 1] },
        getSliceTexFrac: () => 0,
      } as unknown as NVModel
      const clickX = ltwh[0] + 0.25 * ltwh[2]
      const clickY = ltwh[1] + 0.5 * ltwh[3]
      const mm = screenSlicePick([tile], model, clickX, clickY, {
        tileIndex: 0,
        isRender: false,
        sliceType: SAG,
        normalizedX: 0,
        normalizedY: 0,
      })
      expect(mm).not.toBeNull()
      if (!mm) return
      const midY = (EXTENTS_MIN[1] + EXTENTS_MAX[1]) / 2
      // A click left of centre is anterior exactly when the nose is left.
      expect(mm[1] > midY).toBe(c.noseLeft)
      const [px, py] = projectMMToCanvas(mm, mvp, ltwh)
      expect(px).toBeCloseTo(clickX, 4)
      expect(py).toBeCloseTo(clickY, 4)
    }
  })
})

// ---------- rotation2D and 2D flips ----------

const { AXIAL, CORONAL, SAGITTAL, RENDER } = NVConstants.SLICE_TYPE
const ROTATIONS: Rotation2D[] = [0, 90, 180, 270]
// Every display state: 4 rotations x 2 horizontal x 2 vertical flips.
const STATES = ROTATIONS.flatMap((rotation2D) =>
  [false, true].flatMap((isFlipped2DHorizontal) =>
    [false, true].map((isFlipped2DVertical) => ({
      rotation2D,
      isFlipped2DHorizontal,
      isFlipped2DVertical,
    })),
  ),
)
type State = (typeof STATES)[number]
// Anisotropic, with 0 inside every axis so the pick plane (depth 0) is in range.
const ROT_MIN = vec3.fromValues(-40, -70, -30)
const ROT_MAX = vec3.fromValues(60, 50, 50)

const rotCfg = (over: Partial<SliceLayoutConfig> = {}): SliceLayoutConfig => ({
  canvasWH: [900, 600],
  extentsMin: ROT_MIN,
  extentsMax: ROT_MAX,
  sliceType: NVConstants.SLICE_TYPE.MULTIPLANAR,
  ...over,
})

function tileMvp(tile: SliceTile, layout: SliceOrientationSettings): mat4 {
  const screen = tile.screen as { mnMM: vec3; mxMM: vec3 }
  return NVTransforms.calculateMvpMatrix2D(
    tile.leftTopWidthHeight as number[],
    Array.from(screen.mnMM),
    Array.from(screen.mxMM),
    tile.azimuth as number,
    tile.elevation as number,
    isSliceMirrored(tile.axCorSag, layout),
    undefined,
    undefined,
    [3, -4, 1.5],
    true,
    tile.clipRot,
  )[0]
}

// A world point as tile-centred screen coordinates (x right, y down, +-0.5).
function screenUV(tile: SliceTile, mvp: mat4, mm: number[]): [number, number] {
  const ltwh = tile.leftTopWidthHeight as number[]
  const [x, y] = projectMMToCanvas(mm as [number, number, number], mvp, ltwh)
  return [(x - ltwh[0]) / ltwh[2] - 0.5, (y - ltwh[1]) / ltwh[3] - 0.5]
}

// displayed = H^h V^v R(theta) base, theta clockwise on screen (y down).
function expected([x, y]: [number, number], s: State): [number, number] {
  for (let k = 0; k < s.rotation2D / 90; k++) [x, y] = [-y, x]
  if (s.isFlipped2DVertical) y = -y
  if (s.isFlipped2DHorizontal) x = -x
  return [x, y]
}

test('render tiles ignore the 2D flips', () => {
  const layout = { isRadiological: true, isFlipped2DHorizontal: true }
  expect(isSliceMirrored(RENDER, layout)).toBe(true)
  expect(isSliceMirrored(AXIAL, layout)).toBe(false)
})

describe('layout under rotation2D', () => {
  const paths: Partial<SliceLayoutConfig>[] = [
    {},
    { multiplanarLayout: 1 },
    { multiplanarLayout: 2 },
    { multiplanarLayout: 3 },
    { multiplanarShowRender: 1 },
    { isMultiplanarEqualSize: true },
    { sliceType: AXIAL },
    { sliceType: SAGITTAL, isSingleViewFillCanvas: false },
    { heroImageFraction: 0.4, heroSliceType: CORONAL },
    { sliceMosaicString: 'A -10 0 10 ; S R X 0 C 5' },
    {
      customLayout: [
        { sliceType: SAGITTAL, position: [0, 0, 0.5, 1] },
        { sliceType: AXIAL, position: [0.5, 0, 0.5, 1], fill: true },
      ],
    },
  ]
  const rects = (tiles: SliceTile[]) => tiles.map((t) => t.leftTopWidthHeight)

  test('0 and 180 leave every rect unchanged; flips never move a rect', () => {
    for (const path of paths) {
      const base = screenSlicesLayout(rotCfg(path))
      for (const s of STATES) {
        const tiles = screenSlicesLayout(rotCfg({ ...path, ...s }))
        if (s.rotation2D % 180 === 0) expect(rects(tiles)).toEqual(rects(base))
        else
          expect(rects(tiles)).toEqual(
            rects(screenSlicesLayout(rotCfg({ ...path, rotation2D: 90 }))),
          )
      }
    }
  })

  test('the unturned layout is byte-identical, with no clipRot', () => {
    for (const path of paths) {
      const base = screenSlicesLayout(rotCfg(path))
      expect(screenSlicesLayout(rotCfg({ ...path, rotation2D: 0 }))).toEqual(
        base,
      )
      for (const t of base) expect(t.clipRot).toBeUndefined()
    }
  })

  test('quarter turns keep the slice aspect, inside the canvas, without overlap', () => {
    for (const path of paths) {
      const tiles = screenSlicesLayout(rotCfg({ ...path, rotation2D: 90 }))
      for (const t of tiles) {
        const [l, top, w, h] = t.leftTopWidthHeight as number[]
        expect(l).toBeGreaterThanOrEqual(-1e-9)
        expect(top).toBeGreaterThanOrEqual(-1e-9)
        expect(l + w).toBeLessThanOrEqual(900 + 1e-9)
        expect(top + h).toBeLessThanOrEqual(600 + 1e-9)
        if (t.axCorSag === RENDER) {
          expect(t.clipRot).toBeUndefined()
          continue
        }
        expect(t.clipRot).toBe(90)
        // Turned: the U span runs down the tile, V across, at one scale.
        const s = t.screen as { mnMM: vec3; mxMM: vec3 }
        expect((s.mxMM[0] - s.mnMM[0]) / h).toBeCloseTo(
          (s.mxMM[1] - s.mnMM[1]) / w,
          9,
        )
      }
      for (let i = 0; i < tiles.length; i++)
        for (let j = i + 1; j < tiles.length; j++) {
          const [a, b] = [tiles[i], tiles[j]].map(
            (t) => t.leftTopWidthHeight as number[],
          )
          const overlap =
            a[0] < b[0] + b[2] - 1e-9 &&
            b[0] < a[0] + a[2] - 1e-9 &&
            a[1] < b[1] + b[3] - 1e-9 &&
            b[1] < a[1] + a[3] - 1e-9
          expect(overlap).toBe(false)
        }
    }
  })

  test('mosaic render tiles keep the unflipped view', () => {
    const mosaic = { sliceMosaicString: 'A R 0' }
    const [base] = screenSlicesLayout(rotCfg(mosaic))
    for (const s of STATES) {
      const [r] = screenSlicesLayout(rotCfg({ ...mosaic, ...s }))
      expect([r.azimuth, r.elevation, r.leftTopWidthHeight]).toEqual([
        base.azimuth,
        base.elevation,
        base.leftTopWidthHeight,
      ])
    }
  })
})

describe('display states draw H^h V^v R(theta) of the base view', () => {
  test('every orientation, base and state; picks invert the projection', () => {
    for (const sliceType of [AXIAL, CORONAL, SAGITTAL]) {
      for (const isRadiological of [false, true]) {
        const config = (s: Partial<State> = {}) =>
          rotCfg({
            sliceType,
            isSingleViewFillCanvas: false,
            isRadiologicalConvention: isRadiological,
            ...s,
          })
        const [baseTile] = screenSlicesLayout(config())
        const baseMvp = tileMvp(baseTile, { isRadiological })
        const dim = [2, 1, 0][sliceType]
        const points = [
          [5, 10, 20],
          [-30, 40, 45],
          [55, -60, -25],
        ].map((p) => {
          const q = [...p]
          q[dim] = 0
          return q
        })
        for (const s of STATES) {
          const layout = { isRadiological, ...s }
          const [tile] = screenSlicesLayout(config(s))
          const mvp = tileMvp(tile, layout)
          for (const p of points) {
            const want = expected(screenUV(baseTile, baseMvp, p), s)
            const got = screenUV(tile, mvp, p)
            expect(got[0]).toBeCloseTo(want[0], 9)
            expect(got[1]).toBeCloseTo(want[1], 9)
          }
          // The pick fallback (no cached MVP) must invert the same projection.
          const model = {
            volumes: [{}],
            tex2mm: mat4.create(),
            layout,
            scene: { pan2Dxyzmm: [3, -4, 1.5, 1] },
            getSliceTexFrac: () => 0,
          } as unknown as NVModel
          const ltwh = tile.leftTopWidthHeight as number[]
          const pan = [0, 0, 0, 1.5]
          pan[[0, 0, 1][sliceType]] = 3
          pan[[1, 2, 2][sliceType]] = -4
          model.scene.pan2Dxyzmm = pan
          const p = points[0]
          const [cx, cy] = projectMMToCanvas(
            p as [number, number, number],
            mvp,
            ltwh,
          )
          const mm = screenSlicePick([tile], model, cx, cy, {
            tileIndex: 0,
            isRender: false,
            sliceType,
            normalizedX: 0,
            normalizedY: 0,
          })
          expect(mm).not.toBeNull()
          for (let i = 0; i < 3; i++) expect(mm?.[i]).toBeCloseTo(p[i], 4)
        }
      }
    }
  })
})

describe('rotate2D and flip2D act on screen', () => {
  const state = (nv: NiiVue): State => ({
    rotation2D: nv.rotation2D,
    isFlipped2DHorizontal: nv.isFlipped2DHorizontal,
    isFlipped2DVertical: nv.isFlipped2DVertical,
  })
  // Tile-centred screen position of a world point in a single axial tile.
  const uv = (s: State, mm: number[]): [number, number] => {
    const [tile] = screenSlicesLayout(
      rotCfg({ sliceType: AXIAL, isSingleViewFillCanvas: false, ...s }),
    )
    return screenUV(tile, tileMvp(tile, { isRadiological: false, ...s }), mm)
  }
  const p = [20, -35, 0]
  const near = (got: number[], want: number[]) => {
    expect(got[0]).toBeCloseTo(want[0], 9)
    expect(got[1]).toBeCloseTo(want[1], 9)
  }

  test('rotate2D(1) turns clockwise and rotate2D(-1) back, in every state', () => {
    for (const s of STATES) {
      const nv = new NiiVue(s)
      const [x, y] = uv(s, p)
      nv.rotate2D(1)
      // Clockwise on a y-down screen: (x, y) -> (-y, x).
      near(uv(state(nv), p), [-y, x])
      nv.rotate2D(-1)
      expect(state(nv)).toEqual(s)
    }
  })

  test('rotate then flip mirrors the turned image about the screen axis', () => {
    for (const s of STATES) {
      const nv = new NiiVue(s)
      nv.rotate2D(1)
      const [x, y] = uv(state(nv), p)
      nv.flip2D('horizontal')
      near(uv(state(nv), p), [-x, y])
      nv.flip2D('vertical')
      near(uv(state(nv), p), [-x, -y])
    }
  })
})
