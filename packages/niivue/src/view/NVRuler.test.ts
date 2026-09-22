import { describe, expect, test } from 'bun:test'
import { vec3 } from 'gl-matrix'
import type { GlyphBatch } from './NVFont'
import type { LineData } from './NVLine'
import { buildRuler } from './NVRuler'
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

  test('umLadderWalksTheSubMmDecades_notJustOne', () => {
    // A single pass of NICE_VALUES spans one decade; without the decade walk
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
})
