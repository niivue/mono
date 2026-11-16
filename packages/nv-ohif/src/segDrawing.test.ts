import { describe, expect, test } from 'bun:test'
import type { OhifDisplaySet } from './ohif-types'
import {
  resolveSegDisplaySets,
  segColormap,
  startSegDrawing,
} from './segDrawing'

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

  test('lateralityModifier_prefixesSharedLabel', () => {
    const left = { CodeMeaning: 'Left' }
    const cmap = segColormap([
      {
        LabelValue: 1,
        SegmentLabel: 'Putamen',
        SegmentedPropertyTypeModifierCode: left,
      },
      {
        LabelValue: 2,
        SegmentLabel: 'Left Putamen',
        SegmentedPropertyTypeModifierCode: left,
      },
    ])
    expect(cmap.labels).toEqual(['', 'Left Putamen', 'Left Putamen'])
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
})

describe('startSegDrawing', () => {
  // A pane whose core loadDrawing waits on `release` (a slow File read).
  function pane(isShown: boolean) {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const calls: string[] = []
    const nv = {
      loadDrawing: async () => {
        calls.push('load')
        await gate
        return isShown
      },
      closeDrawing: () => calls.push('close'),
      addColormap: (name: string) => {
        calls.push('colormap')
        return name
      },
      drawColormap: '',
      drawIsEnabled: true,
      drawOpacity: 1,
      drawRimOpacity: -1,
    }
    return { nv, calls, release }
  }
  const segDs: OhifDisplaySet = {
    displaySetInstanceUID: 'seg',
    Modality: 'SEG',
  }
  const converted = {
    image: new File([], 'seg.nii'),
    json: { Segments: [{ LabelValue: 1, RGB: [1, 2, 3] }] },
  }
  const convert = async () => converted
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test('shown_coloursFromSidecar_penOff_rimOverFill', async () => {
    const { nv, calls, release } = pane(true)
    startSegDrawing(nv, segDs, { setNote: () => {}, convert })
    release()
    await settle()
    expect(calls).toEqual(['load', 'colormap'])
    expect(nv.drawColormap).toBe('seg-seg')
    expect(nv.drawIsEnabled).toBe(false)
    expect(nv.drawRimOpacity).toBeGreaterThan(nv.drawOpacity)
  })

  test('cleanupWhileCoreLoadPending_closesIt_thenTouchesNothing', async () => {
    const { nv, calls, release } = pane(false) // core gives way once closed
    const stop = startSegDrawing(nv, segDs, { setNote: () => {}, convert })
    await settle()
    stop()
    release()
    await settle()
    expect(calls).toEqual(['load', 'close'])
    expect(nv.drawIsEnabled).toBe(true)
  })

  test('refusedLoad_notes_andCleanupLeavesOtherDrawingsAlone', async () => {
    const { nv, calls, release } = pane(false)
    const notes: string[] = []
    const stop = startSegDrawing(nv, segDs, {
      setNote: (m) => notes.push(m),
      convert,
    })
    release()
    await settle()
    stop()
    expect(calls).toEqual(['load'])
    expect(notes).toHaveLength(1)
  })
})
