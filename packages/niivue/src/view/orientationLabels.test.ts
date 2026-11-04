import { describe, expect, test } from 'bun:test'
import * as NVConstants from '@/NVConstants'
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
