import { describe, expect, test } from 'bun:test'
import * as NVConstants from '@/NVConstants'
import type { Rotation2D } from '@/NVTypes'
import {
  orientationTextPlacements,
  type SliceEdgeLabels,
  sliceEdgeLabels,
} from './orientationLabels'

const { AXIAL, CORONAL, SAGITTAL, RENDER } = NVConstants.SLICE_TYPE

describe('sliceEdgeLabels', () => {
  test('axialAndCoronalFollowIsRadiologicalNotTheNose', () => {
    for (const isSagittalNoseLeft of [null, false, true]) {
      expect(
        sliceEdgeLabels(AXIAL, { isRadiological: false, isSagittalNoseLeft }),
      ).toEqual({ left: 'L', right: 'R', top: 'A', bottom: 'P' })
      expect(
        sliceEdgeLabels(AXIAL, { isRadiological: true, isSagittalNoseLeft }),
      ).toEqual({ left: 'R', right: 'L', top: 'A', bottom: 'P' })
      expect(
        sliceEdgeLabels(CORONAL, { isRadiological: false, isSagittalNoseLeft }),
      ).toEqual({ left: 'L', right: 'R', top: 'S', bottom: 'I' })
      expect(
        sliceEdgeLabels(CORONAL, { isRadiological: true, isSagittalNoseLeft }),
      ).toEqual({ left: 'R', right: 'L', top: 'S', bottom: 'I' })
    }
  })

  test('sagittalLabelsFollowTheNoseInAllFourCombinations', () => {
    const noseLeft: SliceEdgeLabels = {
      left: 'A',
      right: 'P',
      top: 'S',
      bottom: 'I',
    }
    const noseRight: SliceEdgeLabels = {
      left: 'P',
      right: 'A',
      top: 'S',
      bottom: 'I',
    }
    const cases: [boolean, boolean | null, SliceEdgeLabels][] = [
      [false, null, noseRight], // unset follows neurological
      [true, null, noseLeft], // unset follows radiological
      [false, false, noseRight],
      [false, true, noseLeft],
      [true, false, noseRight],
      [true, true, noseLeft],
    ]
    for (const [isRadiological, isSagittalNoseLeft, want] of cases) {
      expect(
        sliceEdgeLabels(SAGITTAL, { isRadiological, isSagittalNoseLeft }),
      ).toEqual(want)
    }
  })

  test('renderTilesHaveNoEdgeLabels', () => {
    expect(sliceEdgeLabels(RENDER, { isRadiological: false })).toBeNull()
  })
})

describe('orientationTextPlacements', () => {
  const tile = [100, 50, 400, 200]

  test('edgesPutTheLeftLetterMidLeftAndTheTopLetterMidTop', () => {
    expect(
      orientationTextPlacements(
        CORONAL,
        { isRadiological: true },
        'edges',
        tile,
      ),
    ).toEqual([
      { text: 'R', x: 104, y: 150, anchorX: 0, anchorY: 0.5 },
      { text: 'S', x: 300, y: 54, anchorX: 0.5, anchorY: 0 },
    ])
  })

  test('cornerDrawsOneCombinedLabelHangingFromTheTopLeft', () => {
    expect(
      orientationTextPlacements(
        CORONAL,
        { isRadiological: true },
        'corner',
        tile,
      ),
    ).toEqual([{ text: 'RS', x: 104, y: 54, anchorX: 0, anchorY: 0 }])
    expect(
      orientationTextPlacements(
        CORONAL,
        { isRadiological: true },
        'corner',
        tile,
        10,
      ),
    ).toEqual([{ text: 'RS', x: 110, y: 60, anchorX: 0, anchorY: 0 }])
  })

  test('cornerTextFollowsRadiologicalAndTheSagittalNose', () => {
    const corner = (
      axCorSag: number,
      isRadiological: boolean,
      isSagittalNoseLeft: boolean | null = null,
    ) =>
      orientationTextPlacements(
        axCorSag,
        { isRadiological, isSagittalNoseLeft },
        'corner',
        tile,
      ).map((t) => t.text)
    expect(corner(AXIAL, false)).toEqual(['LA'])
    expect(corner(AXIAL, true)).toEqual(['RA'])
    expect(corner(CORONAL, false)).toEqual(['LS'])
    expect(corner(SAGITTAL, false)).toEqual(['PS'])
    expect(corner(SAGITTAL, true)).toEqual(['AS'])
    expect(corner(SAGITTAL, false, true)).toEqual(['AS'])
    expect(corner(SAGITTAL, true, false)).toEqual(['PS'])
  })

  test('renderTilesGetNoOrientationText', () => {
    for (const position of ['edges', 'corner'] as const) {
      expect(
        orientationTextPlacements(
          RENDER,
          { isRadiological: false },
          position,
          tile,
        ),
      ).toEqual([])
    }
  })
})

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

describe('sliceEdgeLabels under rotation and flips', () => {
  test('spot checks: left, top, right, bottom', () => {
    const edges = (axCorSag: number, s: Partial<(typeof STATES)[number]>) => {
      const e = sliceEdgeLabels(axCorSag, { isRadiological: false, ...s })
      return e && `${e.left}${e.top}${e.right}${e.bottom}`
    }
    expect(edges(AXIAL, { rotation2D: 90 })).toBe('PLAR')
    expect(edges(AXIAL, { rotation2D: 90, isFlipped2DHorizontal: true })).toBe(
      'ALPR',
    )
    expect(edges(SAGITTAL, { rotation2D: 270 })).toBe('SAIP')
    expect(edges(RENDER, { rotation2D: 90 })).toBeNull()
  })

  test('every state moves the base letters as H^h V^v R(theta) moves the edges', () => {
    const at: Record<string, [number, number]> = {
      left: [-0.5, 0],
      top: [0, -0.5],
      right: [0.5, 0],
      bottom: [0, 0.5],
    }
    for (const t of [AXIAL, CORONAL, SAGITTAL]) {
      const base = sliceEdgeLabels(t, { isRadiological: true })
      for (const s of STATES) {
        const got = sliceEdgeLabels(t, { isRadiological: true, ...s })
        for (const [edge, letter] of Object.entries(base ?? {})) {
          let [x, y] = at[edge]
          // Clockwise on screen (y down), then the on-screen flips.
          for (let k = 0; k < s.rotation2D / 90; k++) [x, y] = [-y, x]
          if (s.isFlipped2DVertical) y = -y
          if (s.isFlipped2DHorizontal) x = -x
          const moved = Object.keys(at).find(
            (k) => at[k][0] === x + 0 && at[k][1] === y + 0,
          ) as keyof SliceEdgeLabels
          expect(got?.[moved]).toBe(letter)
        }
      }
    }
  })
})
