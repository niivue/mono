import { describe, expect, test } from 'bun:test'
import { vec3 } from 'gl-matrix'
import type { Rotation2D } from '@/NVTypes'
import type { GlyphBatch } from './NVFont'
import type { LineData } from './NVLine'
import { buildRuler, chooseRulerSize } from './NVRuler'
import {
  type SliceLayoutConfig,
  type SliceTile,
  screenSlicesLayout,
} from './NVSliceLayout'

// Anisotropic on purpose: with a cube every orientation has the same in-plane
// spans, which is exactly what hid the sagittal axis bug.
const RANGE: [number, number, number] = [180, 216, 180]

function cfg(over: Partial<SliceLayoutConfig> = {}): SliceLayoutConfig {
  return {
    canvasWH: [2000, 400],
    extentsMin: vec3.fromValues(0, 0, 0),
    extentsMax: vec3.fromValues(...RANGE),
    sliceType: 0,
    ...over,
  }
}

// In-plane [u, v] mm spans per orientation, straight from the extents.
const inPlane = (sliceType: number): [number, number] =>
  sliceType === 0
    ? [RANGE[0], RANGE[1]]
    : sliceType === 1
      ? [RANGE[0], RANGE[2]]
      : [RANGE[1], RANGE[2]]

// Record the geometry buildRuler emits: the bar's pixel width, the mm it claims
// to represent, and the px-per-mm those imply.
function measure(
  sliceType: number,
  fill: boolean,
  zoom: number,
  over: Partial<SliceLayoutConfig> = {},
  mmPerUnit = 1,
): { pxPerMM: number; barPx: number; label: string } {
  const tiles = screenSlicesLayout(
    cfg({ sliceType, isSingleViewFillCanvas: fill, ...over }),
  )
  const lines: Array<[number, number]> = []
  let label = ''
  buildRuler(
    tiles,
    (s: string) => {
      label = s
      return {} as GlyphBatch
    },
    (x0: number, _y0: number, x1: number) => {
      lines.push([x0, x1])
      return {} as LineData
    },
    [1, 1, 1, 1],
    [0, 0, 0, zoom],
    mmPerUnit,
  )
  const m = /^(\d+) (cm|mm|um)$/.exec(label)
  if (!m) throw new Error(`no ruler drawn (label: "${label}")`)
  const barPx =
    Math.max(...lines.map((l) => l[1])) - Math.min(...lines.map((l) => l[0]))
  const labelMM = Number(m[1]) * (m[2] === 'cm' ? 10 : m[2] === 'um' ? 1e-3 : 1)
  return { pxPerMM: barPx / labelMM, barPx, label }
}

describe('buildRuler', () => {
  test('barIsSizedByTheImage_notTheEmptyMarginAFilledTileAdds', () => {
    // A filled tile is the whole canvas, so sizing on tile width alone let the
    // bar outgrow a small volume: a 4 mm cube drew a 10 mm bar 2.5x wider than
    // the slice. Filling must not change the chosen length.
    const small = {
      extentsMax: vec3.fromValues(4, 4, 4),
      canvasWH: [2000, 400] as [number, number],
    }
    const boxed = measure(0, false, 1, small)
    const filled = measure(0, true, 1, small)
    // px-per-mm alone does not catch this -- it is right either way. The bar's
    // chosen length is what ran away.
    expect(filled.label).toBe(boxed.label)
    expect(filled.barPx).toBeCloseTo(boxed.barPx, 6)
  })

  test('ignoresTilesThatAreNotAPlainSlice', () => {
    // slicePanUV indexes by orientation; a render or foreign tile used to be
    // skipped and must not throw the whole frame instead.
    for (const axCorSag of [4, 3, undefined]) {
      const [tile] = screenSlicesLayout(cfg())
      expect(() =>
        buildRuler(
          [{ ...tile, axCorSag } as SliceTile],
          () => ({}) as GlyphBatch,
          () => ({}) as LineData,
          [1, 1, 1, 1],
          [0, 0, 0, 1],
        ),
      ).not.toThrow()
    }
  })

  test('subMillimetreFovStillGetsABar_labelledInUm', () => {
    // A microscopy field of view narrower than the smallest nice mm value
    // used to fall off the end of chooseRulerSize and draw no ruler at all.
    // maxMM = 0.65 * 0.4 = 0.26, so the um ladder picks 200 um.
    const r = measure(0, false, 1, {
      extentsMax: vec3.fromValues(0.4, 0.4, 0.4),
    })
    expect(r.label).toBe('200 um')
    // The bar must still be as long as its label claims: fit scale is
    // min(2000 / 0.4, 400 / 0.4) px per mm.
    expect(r.pxPerMM).toBeCloseTo(400 / 0.4, 3)
  })

  test('umLadderWalksTheSubMmScales_notJustOne', () => {
    // A single pass of NICE_VALUES spans one factor of ten; without the walk
    // a few-hundred-micron slide window would get a 10 um sliver of a bar.
    // maxMM = 0.65 * 0.3 = 0.195, so the ladder picks 100 um.
    const r = measure(0, false, 1, {
      extentsMax: vec3.fromValues(0.3, 0.3, 0.3),
    })
    expect(r.label).toBe('100 um')
    expect(r.pxPerMM).toBeCloseTo(400 / 0.3, 3)
  })

  test('boundaryBetweenMmAndUm_isTheSmallestNiceMmValue', () => {
    // mm keeps every field of view where 1 mm still fits in 65% of the tile;
    // just below that the um ladder takes over at its top (500 um), so the
    // handover does not jump to a tiny bar.
    const mm = measure(0, false, 1, {
      extentsMax: vec3.fromValues(1.6, 1.6, 1.6), // maxMM = 1.04
    })
    expect(mm.label).toBe('1 mm')
    const um = measure(0, false, 1, {
      extentsMax: vec3.fromValues(1.5, 1.5, 1.5), // maxMM = 0.975
    })
    expect(um.label).toBe('500 um')
  })

  test('barLengthMatchesItsLabelInEveryOrientation', () => {
    // Truth is independent of the implementation: the fit scale is what maps
    // the slice onto the tile, and the 2D zoom multiplies it. Filling changes
    // the tile and the mm window together, so it must not change the scale.
    for (const sliceType of [0, 1, 2]) {
      const [u, v] = inPlane(sliceType)
      const fit = Math.min(2000 / u, 400 / v)
      for (const fill of [false, true]) {
        for (const zoom of [1, 3]) {
          expect(measure(sliceType, fill, zoom).pxPerMM).toBeCloseTo(
            fit * zoom,
            6,
          )
        }
      }
    }
  })

  test('micrometerVolume_isLabelledInTissueMm_notSceneUnits', () => {
    // A 5000-unit FOV on a um volume is 5 mm of tissue: same bar as a 5 mm volume.
    const um = measure(
      0,
      false,
      1,
      { extentsMax: vec3.fromValues(5000, 5000, 5000) },
      1e-3,
    )
    const mm = measure(0, false, 1, {
      extentsMax: vec3.fromValues(5, 5, 5),
    })
    expect(um.label).toBe('2 mm')
    expect(um.label).toBe(mm.label)
    expect(um.barPx).toBeCloseTo(mm.barPx, 6)
  })
})

describe('ruler cap under a quarter turn', () => {
  test('caps by the horizontal data span', () => {
    const label = (rotation2D: Rotation2D) => {
      const tiles = screenSlicesLayout(
        cfg({
          canvasWH: [3000, 3000],
          extentsMax: vec3.fromValues(20, 200, 10),
          rotation2D,
        }),
      )
      const labels: string[] = []
      buildRuler(
        tiles,
        (text) => {
          labels.push(text)
          return {} as GlyphBatch
        },
        () => ({}) as LineData,
        [1, 1, 1, 1],
        [0, 0, 0, 0.05],
      )
      return labels.join(' ')
    }
    // Zoomed far out the cap is the data span: X (20 mm) unturned, Y (200 mm)
    // across a quarter-turned axial tile.
    expect([label(0), label(90), label(180), label(270)]).toEqual([
      '10 mm',
      '10 cm',
      '10 mm',
      '10 cm',
    ])
  })

  test('drawsOnTheRenderTileOnlyWhenGivenARenderScale', () => {
    // A setSlidePlane slide lives on the render tile; the views pass its
    // orthographic scale only then, so volume renders keep no ruler.
    const tiles: SliceTile[] = [
      { leftTopWidthHeight: [0, 0, 1000, 500], axCorSag: 4 },
    ]
    const run = (renderScale?: {
      furthestFromPivot: number
      scaleMultiplier: number
    }) => {
      const xs: number[] = []
      let label = ''
      buildRuler(
        tiles,
        (s: string) => {
          label = s
          return {} as GlyphBatch
        },
        (x0: number, _y0: number, x1: number) => {
          xs.push(x0, x1)
          return {} as LineData
        },
        [1, 1, 1, 1],
        [0, 0, 0, 1],
        1,
        renderScale,
      )
      return { label, barPx: Math.max(...xs) - Math.min(...xs) }
    }
    expect(run().label).toBe('')
    // 2 * 0.8 * 125 mm over the 500 px short side: 0.4 mm/px, 1000 px = 400 mm.
    expect(run({ furthestFromPivot: 125, scaleMultiplier: 1 })).toEqual({
      label: '10 cm',
      barPx: 250,
    })
    // Zoom 100x: 4 mm across the tile, a 2 mm bar of 500 px.
    expect(run({ furthestFromPivot: 125, scaleMultiplier: 100 })).toEqual({
      label: '2 mm',
      barPx: 500,
    })
    // A mosaic render tile ("A R 0") is projected from its own screen bounds,
    // not the scene radius and zoom: without them it gets no ruler.
    tiles[0].renderOrientation = 0
    expect(run({ furthestFromPivot: 125, scaleMultiplier: 1 }).label).toBe('')
  })
})

describe('ruler on mosaic render and global3d tiles', () => {
  const draw = (tiles: SliceTile[], units?: 'um') => {
    const xs: number[] = []
    let label = ''
    buildRuler(
      tiles,
      (s: string) => {
        label = s
        return {} as GlyphBatch
      },
      (x0: number, _y0: number, x1: number) => {
        xs.push(x0, x1)
        return {} as LineData
      },
      [1, 1, 1, 1],
      [0, 0, 0, 1],
      1,
      undefined,
      units,
    )
    return { label, barPx: xs.length ? Math.max(...xs) - Math.min(...xs) : 0 }
  }
  const screen = {
    mnMM: [-90, -108, -72],
    mxMM: [90, 108, 72],
    fovMM: [180, 216, 144],
  }

  test('a mosaic render tile is scaled by its screen span over its width', () => {
    // 180 mm over 360 px: 0.5 mm/px; field 180 mm, so a 10 cm bar of 200 px.
    // No render scale is needed: a mosaic render tile does not use the camera.
    const tile = {
      leftTopWidthHeight: [0, 0, 360, 432],
      axCorSag: 4,
      renderOrientation: 0,
      screen,
    } as unknown as SliceTile
    expect(draw([tile])).toEqual({ label: '10 cm', barPx: 200 })
  })

  test('the widest mosaic render tile carries it; a 2D tile still wins', () => {
    const tile = (w: number) =>
      ({
        leftTopWidthHeight: [0, 0, w, w],
        axCorSag: 4,
        renderOrientation: 0,
        screen,
      }) as unknown as SliceTile
    // 180 mm over 720 px: 0.25 mm/px, a 10 cm bar of 400 px.
    expect(draw([tile(360), tile(720)]).barPx).toBe(400)
    const [slice] = screenSlicesLayout(cfg())
    expect(draw([tile(720), slice as SliceTile])).toEqual(
      draw([slice as SliceTile]),
    )
  })

  test('a global3d tile gets none: its camera is perspective', () => {
    const tile = {
      leftTopWidthHeight: [0, 0, 360, 432],
      axCorSag: 4,
      renderOrientation: 0,
      space: 'global3d',
      screen,
    } as unknown as SliceTile
    expect(draw([tile]).label).toBe('')
  })

  test('global3d tiles never get one; ortho render, mosaic and 2D tiles keep it (owner)', () => {
    const renderScale = { furthestFromPivot: 100, scaleMultiplier: 1 }
    const ruler = (tiles: SliceTile[]) => {
      let label = ''
      buildRuler(
        tiles,
        (t: string) => {
          label = t
          return {} as GlyphBatch
        },
        () => ({}) as LineData,
        [1, 1, 1, 1],
        [0, 0, 0, 1],
        1,
        renderScale,
      )
      return label
    }
    const render = (space?: 'global3d') =>
      ({
        leftTopWidthHeight: [0, 0, 400, 400],
        axCorSag: 4,
        ...(space && { space }),
        screen,
      }) as unknown as SliceTile
    const mosaic = {
      leftTopWidthHeight: [0, 0, 360, 432],
      axCorSag: 4,
      renderOrientation: 0,
      screen,
    } as unknown as SliceTile
    const [slice] = screenSlicesLayout(cfg())
    // A perspective global3d render tile, even with a render scale: none.
    expect(ruler([render('global3d')])).toBe('')
    // The orthographic render tile beside it keeps the bar.
    expect(ruler([render('global3d'), render()])).not.toBe('')
    expect(ruler([render('global3d'), mosaic])).not.toBe('')
    expect(ruler([slice as SliceTile])).not.toBe('')
    expect(ruler([render('global3d'), slice as SliceTile])).toBe(
      ruler([slice as SliceTile]),
    )
  })

  test('a fixed unit relabels the mosaic bar', () => {
    const tile = {
      leftTopWidthHeight: [0, 0, 360, 432],
      axCorSag: 4,
      renderOrientation: 0,
      screen,
    } as unknown as SliceTile
    // 0.65 * 180 mm = 117 mm = 117000 um: 100000 um, 200 px.
    expect(draw([tile], 'um')).toEqual({ label: '100000 um', barPx: 200 })
  })
})

describe('chooseRulerSize units', () => {
  test("'auto' is unchanged", () => {
    expect(chooseRulerSize(100)).toEqual(chooseRulerSize(100, 'auto'))
    expect(chooseRulerSize(100)).toEqual({ lengthMM: 50, label: '5 cm' })
  })

  test('a fixed unit takes the largest 1/2/5 x 10^n that fits 65%', () => {
    expect(chooseRulerSize(100, 'mm')).toEqual({ lengthMM: 50, label: '50 mm' })
    expect(chooseRulerSize(100, 'cm')).toEqual({ lengthMM: 50, label: '5 cm' })
    expect(chooseRulerSize(0.4, 'um')).toEqual({
      lengthMM: 0.2,
      label: '200 um',
    })
    expect(chooseRulerSize(0.4, 'mm')).toEqual({
      lengthMM: 0.2,
      label: '0.2 mm',
    })
    expect(chooseRulerSize(0.0004, 'nm')?.label).toBe('200 nm')
    expect(chooseRulerSize(1, 'cm')).toEqual({
      lengthMM: 0.5,
      label: '0.05 cm',
    })
    expect(chooseRulerSize(0, 'mm')).toBeNull()
  })
})
