import { describe, expect, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { DEFAULT_OPTIONS } from './NiivueViewport'
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

  test('missingRGBAndLabel_defaultWhiteAndValue_missingValueSkipped', () => {
    const cmap = segColormap([{ LabelValue: 2 }, { SegmentLabel: 'x' }])
    expect(cmap.I).toEqual([0, 2])
    expect([cmap.R[1], cmap.G[1], cmap.B[1]]).toEqual([255, 255, 255])
    expect(cmap.labels).toEqual(['', '2'])
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

  test('secondarySegOverAnotherSeries_primaryKeepsThePane', () => {
    const ct: OhifDisplaySet = { displaySetInstanceUID: 'ct', Modality: 'CT' }
    expect(resolveSegDisplaySets([ct, seg], lookup)).toEqual({
      displaySets: [ct, seg],
    })
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

describe('startSegDrawing', () => {
  // A pane whose core loadDrawing waits on `release` (a slow File read).
  function pane(isShown: boolean) {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const calls: string[] = []
    const nv = {
      _drawingGeneration: 0,
      loadDrawing: async () => {
        calls.push('load')
        nv._drawingGeneration++
        await gate
        return isShown
      },
      closeDrawing: () => calls.push('close'),
      addColormap: (name: string) => {
        calls.push('colormap')
        return name
      },
      drawColormap: '',
      drawingVolume: null,
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
  const whenBase = Promise.resolve(true)
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test('shown_coloursFromSidecar_penOff_rimOverFill', async () => {
    const { nv, calls, release } = pane(true)
    startSegDrawing(nv, segDs, { setNote: () => {}, convert, whenBase })
    release()
    await settle()
    expect(calls).toEqual(['load', 'colormap'])
    expect(nv.drawColormap).toBe('seg-seg')
    expect(nv.drawIsEnabled).toBe(false)
    expect(nv.drawRimOpacity).toBeGreaterThan(nv.drawOpacity)
  })

  test('baseNotYetInstalled_waitsForIt_beforeLoadingDrawing', async () => {
    const { nv, calls, release } = pane(true)
    let installBase = (_: boolean) => {}
    const base = new Promise<boolean>((r) => {
      installBase = r
    })
    startSegDrawing(nv, segDs, { setNote: () => {}, convert, whenBase: base })
    await settle()
    expect(calls).toEqual([])
    installBase(true)
    release()
    await settle()
    expect(calls).toEqual(['load', 'colormap'])
  })

  test('cleanupWhileCoreLoadPending_supersedesIt_thenTouchesNothing', async () => {
    const { nv, calls, release } = pane(false) // core gives way to the bump
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert,
      whenBase,
    })
    await settle()
    stop()
    release()
    await settle()
    expect(calls).toEqual(['load'])
    expect(nv._drawingGeneration).toBe(2)
    expect(nv.drawIsEnabled).toBe(true)
  })

  test('cleanupAfterCoreInstalled_beforeTheSegResumed_closesIt', async () => {
    const { nv, calls, release } = pane(true) // core installed despite the bump
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert,
      whenBase,
    })
    await settle()
    release()
    stop()
    await settle()
    expect(calls).toEqual(['load', 'close'])
  })

  test('cleanupWhileRealCoreReadsTheFile_installsNothing', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let reading = () => {}
    const isReading = new Promise<void>((r) => {
      reading = r
    })
    class SlowFile extends File {
      override async arrayBuffer() {
        reading()
        await gate
        return super.arrayBuffer()
      }
    }
    const image = new SlowFile([labels()], 'seg.nii')
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => ({ ...converted, image }),
      whenBase,
    })
    await isReading
    stop()
    release()
    await settle()
    expect(nv.drawingVolume).toBeNull()
  })

  test('cleanupWhileReadingAfterAnotherDrawingLoaded_keepsIt', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let reading = () => {}
    const isReading = new Promise<void>((r) => {
      reading = r
    })
    class SlowFile extends File {
      override async arrayBuffer() {
        reading()
        await gate
        return super.arrayBuffer()
      }
    }
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => ({
        ...converted,
        image: new SlowFile([labels()], 'seg.nii'),
      }),
      whenBase,
    })
    await isReading
    await nv.loadDrawing(new File([labels()], 'mine.nii'))
    const mine = nv.drawingVolume
    expect(mine).not.toBeNull()
    stop()
    release()
    await settle()
    expect(nv.drawingVolume).toBe(mine)
  })

  test('drawingLoadedDuringConversion_supersedesTheSeg', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    let finish = () => {}
    const converting = new Promise<void>((r) => {
      finish = r
    })
    startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => {
        await converting
        return { ...converted, image: new File([labels()], 'seg.nii') }
      },
      whenBase,
    })
    await nv.loadDrawing(new File([labels()], 'mine.nii'))
    const mine = nv.drawingVolume
    expect(mine).not.toBeNull()
    finish()
    await settle()
    expect(nv.drawingVolume).toBe(mine)
  })

  // A File whose read waits on `release`; `isReading` resolves when it starts.
  function slowFile(name: string) {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let reading = () => {}
    const isReading = new Promise<void>((r) => {
      reading = r
    })
    class SlowFile extends File {
      override async arrayBuffer() {
        reading()
        await gate
        return super.arrayBuffer()
      }
    }
    return { file: new SlowFile([labels()], name), release, isReading }
  }

  test('cleanupWhileSegReads_keepsTheDrawingItWouldReplace', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    await nv.loadDrawing(new File([labels()], 'prior.nii'))
    const prior = nv.drawingVolume
    expect(prior).not.toBeNull()
    const seg = slowFile('seg.nii')
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => ({ ...converted, image: seg.file }),
      whenBase,
    })
    await seg.isReading
    stop()
    seg.release()
    await settle()
    expect(nv.drawingVolume).toBe(prior)
  })

  test('userDrawingStillReadingWhenConversionEnds_winsOverTheSeg', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    let finish = () => {}
    const converting = new Promise<void>((r) => {
      finish = r
    })
    startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => {
        await converting
        return { ...converted, image: new File([labels()], 'seg.nii') }
      },
      whenBase,
    })
    const mine = slowFile('mine.nii')
    const isMineShown = nv.loadDrawing(mine.file)
    await mine.isReading
    finish()
    await settle()
    mine.release()
    expect(await isMineShown).toBe(true)
    await settle()
    expect(nv.drawingVolume).not.toBeNull()
  })

  test('cleanupAfterAnotherDrawingReplacedTheSeg_keepsIt', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    const stop = startSegDrawing(nv, segDs, {
      setNote: () => {},
      convert: async () => ({
        ...converted,
        image: new File([labels()], 'seg.nii'),
      }),
      whenBase,
    })
    await settle()
    expect(nv.drawingVolume).not.toBeNull()
    await nv.loadDrawing(new File([labels()], 'mine.nii'))
    const mine = nv.drawingVolume
    stop()
    expect(nv.drawingVolume).toBe(mine)
  })

  test('refusedLoad_notes_andCleanupLeavesOtherDrawingsAlone', async () => {
    const { nv, calls, release } = pane(false)
    const notes: string[] = []
    const stop = startSegDrawing(nv, segDs, {
      setNote: (m) => notes.push(m),
      convert,
      whenBase,
    })
    release()
    await settle()
    stop()
    expect(calls).toEqual(['load'])
    expect(notes).toHaveLength(1)
  })
})

// A 2x2x2 uint8 NIfTI-1 (1 mm, identity sform): a base, or a label volume on it.
function labels(): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(352 + 8))
  view.setInt32(0, 348, true)
  ;[3, 2, 2, 2].forEach((d, i) => {
    view.setInt16(40 + 2 * i, d, true)
  })
  view.setInt16(70, 2, true) // uint8
  view.setInt16(72, 8, true)
  ;[1, 1, 1, 1].forEach((d, i) => {
    view.setFloat32(76 + 4 * i, d, true)
  })
  view.setFloat32(108, 352, true)
  view.setFloat32(112, 1, true) // scl_slope
  view.setInt16(254, 1, true) // sform_code
  ;[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].forEach((v, i) => {
    view.setFloat32(280 + 4 * i, v, true)
  })
  ;[0x6e, 0x2b, 0x31, 0].forEach((b, i) => {
    view.setUint8(344 + i, b)
  })
  view.setUint8(352, 1)
  return view.buffer
}
