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

  test('hungRtstruct_showsItsReferencedSeriesAsBase', () => {
    const rt = { ...seg, Modality: 'RTSTRUCT' }
    expect(resolveSegDisplaySets([rt], lookup)).toEqual({
      displaySets: [mr],
      seg: rt,
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

  // After hydration the pane hangs only the base (and MPR panes are new).
  test('baseOnly_takesOnlyAHydratedSegOnIt', () => {
    const hydrated = { ...seg, displaySetInstanceUID: 'seg2', isHydrated: true }
    const other = { ...hydrated, referencedDisplaySetInstanceUID: 'ct' }
    const active = (...ds: OhifDisplaySet[]) => ({
      ...lookup,
      getActiveDisplaySets: () => ds,
    })
    expect(resolveSegDisplaySets([mr], active(seg, other)).seg).toBeUndefined()
    expect(resolveSegDisplaySets([mr], active(seg, other, hydrated))).toEqual({
      displaySets: [mr],
      seg: hydrated,
    })
  })

  test('baseOnly_latestHydratedReplacesEarlier', () => {
    const a = { ...seg, displaySetInstanceUID: 'a', isHydrated: false }
    const b = { ...seg, displaySetInstanceUID: 'b', isHydrated: true }
    const active = { ...lookup, getActiveDisplaySets: () => [a, b] }
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    // a, listed first, hydrated second: it wins; un-hydrated, b is back.
    a.isHydrated = true
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
    a.isHydrated = false
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
  })

  // Round 21: removal un-hydrates the same object; reloading it makes it newest.
  test('baseOnly_reloadedSegIsNewest', () => {
    const a = { ...seg, displaySetInstanceUID: 'a', isHydrated: true }
    const b = { ...seg, displaySetInstanceUID: 'b', isHydrated: false }
    const active = { ...lookup, getActiveDisplaySets: () => [a, b] }
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
    b.isHydrated = true
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    a.isHydrated = false
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    a.isHydrated = true
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
  })

  // Removed while another series shows, then reloaded: still newest on its own.
  test('baseOnly_segReloadedWhileElsewhereIsNewest', () => {
    const ct: OhifDisplaySet = { displaySetInstanceUID: 'ct', Modality: 'CT' }
    const a = { ...seg, displaySetInstanceUID: 'a', isHydrated: true }
    const b = { ...seg, displaySetInstanceUID: 'b', isHydrated: false }
    const active = { ...lookup, getActiveDisplaySets: () => [a, b] }
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
    b.isHydrated = true
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    a.isHydrated = false
    resolveSegDisplaySets([ct], active)
    a.isHydrated = true
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
  })

  // Removal can drop the set from the active list instead; a re-add is newest.
  test('baseOnly_reAddedSegIsNewest', () => {
    const a = { ...seg, displaySetInstanceUID: 'a', isHydrated: true }
    const b = { ...seg, displaySetInstanceUID: 'b', isHydrated: true }
    let sets = [a, b]
    const active = { ...lookup, getActiveDisplaySets: () => sets }
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    sets = [b]
    expect(resolveSegDisplaySets([mr], active).seg).toBe(b)
    sets = [a, b]
    expect(resolveSegDisplaySets([mr], active).seg).toBe(a)
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
      drawingGeneration: 0,
      cancelDrawingLoad: () => {
        nv.drawingGeneration++
      },
      loadDrawing: async () => {
        calls.push('load')
        nv.drawingGeneration++
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
      drawRimWidth: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
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
    expect(nv.drawingGeneration).toBe(2)
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

  test('segSupersededOrStopped_restoresTheStyleItReplaced_unlessTheUserChangedIt', async () => {
    globalThis.requestAnimationFrame ??= () => 0
    const nv = new NiiVue(DEFAULT_OPTIONS)
    await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
    nv.drawColormap = 'Draw'
    nv.drawOpacity = 0.8
    nv.drawRimOpacity = -1
    const style = () => [nv.drawColormap, nv.drawOpacity, nv.drawRimOpacity]
    const start = async () => {
      const stop = startSegDrawing(nv, segDs, {
        setNote: () => {},
        convert: async () => ({
          ...converted,
          image: new File([labels()], 'seg.nii'),
        }),
        whenBase,
      })
      await settle()
      expect(style()).toEqual(['Seg-seg', 0.5, 1])
      return stop
    }
    // Superseded: the user's drawing gets its style back before the stop.
    let stop = await start()
    await nv.loadDrawing(new File([labels()], 'mine.nii'))
    expect(style()).toEqual(['Draw', 0.8, -1])
    stop()
    expect(style()).toEqual(['Draw', 0.8, -1])
    // Stopped: the fill opacity the user set since stays.
    stop = await start()
    nv.drawOpacity = 0.3
    stop()
    expect(nv.drawingVolume).toBeNull()
    expect(style()).toEqual(['Draw', 0.3, -1])
  })

  test('shownWithConversionNote_notesIt', async () => {
    const { nv, release } = pane(true)
    const notes: Array<[string, boolean | undefined]> = []
    startSegDrawing(nv, segDs, {
      setNote: (m, brief) => notes.push([m, brief]),
      convert: async () => ({
        ...converted,
        note: 'dcm2niix exit 1: incomplete SEG',
      }),
      whenBase,
    })
    release()
    await settle()
    // Brief, as the base volume's conversion note.
    expect(notes).toEqual([['dcm2niix exit 1: incomplete SEG', true]])
  })

  test('noSidecarSegments_rawFrameStack_notedNotDrawn', async () => {
    const { nv, calls, release } = pane(true)
    const notes: string[] = []
    startSegDrawing(nv, segDs, {
      setNote: (m) => notes.push(m),
      convert: async () => ({ image: converted.image, json: {} }),
      whenBase,
    })
    release()
    await settle()
    expect(calls).toEqual([])
    expect(notes[0]).toContain('no Segments')
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
