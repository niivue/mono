import { describe, expect, test } from 'bun:test'
import type { OhifDisplaySet } from './ohif-types'
import { resolveSegDisplaySets, segColormap } from './segDrawing'

describe('segColormap', () => {
  test('sidecarSegments_becomeLabelColormapWithTransparentZero', () => {
    const cmap = segColormap([
      { LabelValue: 1, SegmentLabel: 'Left-Thalamus', RGB: [0, 118, 14] },
      { LabelValue: 43, SegmentLabel: 'Right-Putamen', RGB: [236, 13, 176] },
    ])
    expect(cmap).toEqual({
      R: [0, 0, 236],
      G: [0, 118, 13],
      B: [0, 14, 176],
      A: [0, 255, 255],
      I: [0, 1, 43],
      labels: ['', 'Left-Thalamus', 'Right-Putamen'],
    })
  })

  test('missingRGBAndLabel_defaultWhiteAndValue_missingValueSkipped', () => {
    const cmap = segColormap([{ LabelValue: 2 }, { SegmentLabel: 'x' }])
    expect(cmap.I).toEqual([0, 2])
    expect([cmap.R[1], cmap.G[1], cmap.B[1]]).toEqual([255, 255, 255])
    expect(cmap.labels).toEqual(['', '2'])
  })
})

describe('resolveSegDisplaySets', () => {
  const mr: OhifDisplaySet = {
    displaySetInstanceUID: 'mr',
    SeriesInstanceUID: 'mr-series',
    Modality: 'MR',
  }
  const seg: OhifDisplaySet = {
    displaySetInstanceUID: 'seg',
    Modality: 'SEG',
    referencedDisplaySetInstanceUID: 'mr',
    referencedSeriesInstanceUID: 'mr-series',
  }
  const lookup = {
    getDisplaySetByUID: (uid: string) => (uid === 'mr' ? mr : undefined),
    getDisplaySetsForSeries: (uid: string) => (uid === 'mr-series' ? [mr] : []),
  }

  test('hungSeg_showsItsReferencedSeriesAsBase', () => {
    expect(resolveSegDisplaySets([seg], lookup)).toEqual({
      displaySets: [mr],
      seg,
    })
  })

  test('segLayeredOnItsBase_baseOnce', () => {
    expect(resolveSegDisplaySets([mr, seg], lookup).displaySets).toEqual([mr])
  })

  test('referenceUidNotYetSet_fallsBackToSeriesUid', () => {
    const early = { ...seg, referencedDisplaySetInstanceUID: null }
    expect(resolveSegDisplaySets([early], lookup).displaySets).toEqual([mr])
  })

  test('noSeg_orUnresolvedReference_unchanged', () => {
    expect(resolveSegDisplaySets([mr], lookup)).toEqual({ displaySets: [mr] })
    const orphan = { ...seg, referencedDisplaySetInstanceUID: 'gone' }
    const lost = { ...orphan, referencedSeriesInstanceUID: 'gone' }
    expect(resolveSegDisplaySets([lost], lookup)).toEqual({
      displaySets: [lost],
    })
  })
})
