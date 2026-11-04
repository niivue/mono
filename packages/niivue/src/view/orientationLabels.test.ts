import { describe, expect, test } from 'bun:test'
import * as NVConstants from '@/NVConstants'
import { type SliceEdgeLabels, sliceEdgeLabels } from './orientationLabels'

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
