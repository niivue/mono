import { describe, expect, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import {
  getSegCommandDefinitions,
  niivueSegmentationDataset,
} from './segCommands'
import { startSegEditing } from './segEdit'
import {
  drawOpacities,
  labelStats,
  niivueSegmentationPane,
  panelColormap,
  startSegPanel,
} from './segPanel'

describe('segPanel', () => {
  test('labelStats_countsAndCentroidsPerLabel', () => {
    // 2x2x2: label 3 at (1,0,0) and (1,1,1); label 7 at (0,1,0).
    const bitmap = new Uint8Array([0, 3, 7, 0, 0, 0, 0, 3])
    const stats = labelStats(bitmap, [2, 2, 2])
    expect(stats.get(3)).toEqual({ count: 2, centroid: [1, 0.5, 0.5] })
    expect(stats.get(7)).toEqual({ count: 1, centroid: [0, 1, 0] })
    expect(stats.size).toBe(2)
  })

  test('drawOpacities_mapsFillOutlineModes', () => {
    expect(drawOpacities({ fillAlpha: 0.3, outlineOpacity: 0.8 })).toEqual({
      fill: 0.3,
      rim: 0.8,
      width: 1,
    })
    expect(drawOpacities({ renderOutline: false, fillAlpha: 0.3 })).toEqual({
      fill: 0.3,
      rim: -1,
      width: 1,
    })
    // Outline only: a nonzero fill keeps the shader drawing the rim.
    expect(drawOpacities({ renderFill: false })).toEqual({
      fill: 1 / 255,
      rim: 1,
      width: 1,
    })
    expect(drawOpacities({ renderFill: false, renderOutline: false })).toEqual({
      fill: 0,
      rim: -1,
      width: 1,
    })
    expect(drawOpacities({ renderFill: false, outlineOpacity: 0 }).fill).toBe(0)
    expect(drawOpacities({ outlineWidth: 3 }).width).toBe(3)
  })

  test('panelColormap_hiddenSegmentIsTransparent', () => {
    const cmap = panelColormap([
      { value: 2, label: 'A', color: [1, 2, 3, 200], visible: true },
      { value: 5, label: 'B', color: [4, 5, 6, 255], visible: false },
    ])
    expect(cmap).toEqual({
      R: [0, 1, 4],
      G: [0, 2, 5],
      B: [0, 3, 6],
      A: [0, 200, 0],
      I: [0, 2, 5],
      labels: ['', 'A', 'B'],
    })
  })
})

// A uint8 NIfTI-1 base: 1 mm voxels, `srow` the sform (3x4, RAS).
function nifti(dims: number[], srow: number[]): File {
  const n = dims.reduce((a, b) => a * b, 1)
  const view = new DataView(new ArrayBuffer(352 + n))
  view.setInt32(0, 348, true)
  for (const [i, d] of [3, ...dims].entries())
    view.setInt16(40 + 2 * i, d, true)
  view.setInt16(70, 2, true) // uint8
  view.setInt16(72, 8, true)
  for (let i = 0; i < 4; i++) view.setFloat32(76 + 4 * i, 1, true)
  view.setFloat32(108, 352, true)
  view.setFloat32(112, 1, true) // scl_slope
  view.setInt16(254, 1, true) // sform_code
  for (const [i, v] of srow.entries()) view.setFloat32(280 + 4 * i, v, true)
  for (const [i, b] of [0x6e, 0x2b, 0x31, 0].entries())
    view.setUint8(344 + i, b)
  return new File([view.buffer], 'base.nii')
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]

// Cornerstone's segmentation state and OHIF's service and history, as far as
// the panel uses them; modified events reach the panel synchronously.
function host(style: object = {}, color = [255, 0, 0, 255]) {
  type Seg = { segments: Record<string, object> }
  const segs = new Map<string, Seg>()
  const reps = new Map<string, object>()
  const luts = new Set<number>()
  const listeners = new Set<(e: { segmentationId?: string }) => void>()
  const memos: Array<{ restoreMemo: (undo?: boolean) => void }> = []
  const segmentation = {
    addSegmentations: ([s]: Array<{ segmentationId: string; config: Seg }>) =>
      s && segs.set(s.segmentationId, { segments: s.config.segments }),
    removeSegmentationRepresentations: (
      vp: string,
      s: { segmentationId: string },
    ) => reps.delete(vp + s.segmentationId),
    state: {
      removeColorLUT: (i: number) => luts.delete(i),
      // Index 0 is cornerstone's default LUT.
      getColorLUT: (i: number) => i === 0 || luts.has(i),
      getSegmentation: (id: string) => segs.get(id),
      getSegmentationRepresentation: (
        vp: string,
        s: { segmentationId: string },
      ) => reps.get(vp + s.segmentationId),
    },
    config: {
      color: {
        addColorLUT: (_: unknown, i: number) => {
          luts.add(i)
          return i
        },
        getSegmentIndexColor: () => color,
      },
      style: { getStyle: () => style },
    },
    defaultSegmentationStateManager: {
      updateState: (fn: (s: object) => void) =>
        fn({ viewportSegRepresentations: {} }),
      addDefaultSegmentationRepresentation: (
        _: unknown,
        vp: string,
        id: string,
      ) => reps.set(vp + id, {}),
    },
    segmentationStyle: {
      setRenderInactiveSegmentations: () => {},
    },
    triggerSegmentationEvents: {
      triggerSegmentationModified: (segmentationId: string) => {
        for (const cb of listeners) cb({ segmentationId })
      },
      triggerSegmentationRepresentationModified: () => {},
    },
  }
  const libs = {
    cornerstoneTools: { segmentation },
    cornerstone: {
      utilities: {
        HistoryMemo: {
          DefaultHistoryMemo: {
            push: (m: (typeof memos)[number]) => memos.push(m),
          },
        },
      },
    },
  }
  const extensionManager = {
    getModuleEntry: () => ({
      exports: { getCornerstoneLibraries: () => libs },
    }),
  }
  const service = {
    EVENTS: { SEGMENTATION_MODIFIED: 'modified' },
    subscribe: (_: string, cb: (e: { segmentationId?: string }) => void) => {
      listeners.add(cb)
      return { unsubscribe: () => listeners.delete(cb) }
    },
    setActiveSegmentation: () => {},
    setActiveSegment: () => {},
  }
  const managers = {
    servicesManager: { services: { segmentationService: service } },
    extensionManager,
  } as never
  return { managers, memos, segs, luts }
}

async function viewer(dims = [2, 2, 1], srow = IDENTITY) {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti(dims, srow) }])
  return nv
}
const img = (nv: NiiVue) => nv.drawingVolume?.img as Uint8Array

describe('segmentation editing', () => {
  const segment = (value: number) => ({
    value,
    label: `S${value}`,
    rgb: [255, 0, 0] as [number, number, number],
  })

  test('createdSegmentation_leavesWithItsBase_andWithItsViewer', async () => {
    const { managers } = host()
    const nv = await viewer()
    registerNiivue('created', nv)
    updateNiivueViewport('created', {
      displaySets: [{ displaySetInstanceUID: 'a' }],
    })
    const commands = getSegCommandDefinitions(managers)
    const create = () =>
      commands.createLabelmapForViewport.commandFn({
        viewportId: 'created',
      }) as string
    const id = create()
    img(nv)[0] = 1
    // The viewport's series swap: the registry first, then the new base.
    updateNiivueViewport('created', {
      displaySets: [{ displaySetInstanceUID: 'b' }],
      baseLoading: true,
    })
    await nv.loadVolumes([{ url: nifti([2, 2, 1], IDENTITY) }])
    expect(nv.drawingVolume).toBeNull()
    expect(niivueSegmentationPane(id)).toBeUndefined()
    const next = create()
    unregisterNiivue('created')
    nv.destroy()
    expect(niivueSegmentationPane(next)).toBeUndefined()
  })

  test('a closed panel removes its colour LUT and the next reuses its index', async () => {
    const { managers, luts } = host()
    const used: number[][] = []
    for (let i = 0; i < 3; i++) {
      const nv = await viewer()
      registerNiivue('lut', nv)
      updateNiivueViewport('lut', {
        displaySets: [{ displaySetInstanceUID: 'a' }],
      })
      getSegCommandDefinitions(managers).createLabelmapForViewport.commandFn({
        viewportId: 'lut',
      })
      used.push([...luts])
      unregisterNiivue('lut')
      nv.destroy()
    }
    expect([used, luts.size]).toEqual([[[1], [1], [1]], 0])
  })

  test('outline only draws a faint segment with an opaque colour', async () => {
    const { managers } = host({ renderFill: false }, [255, 0, 0, 102])
    const nv = await viewer()
    nv.createEmptyDrawing()
    img(nv).set([1, 0, 0, 0])
    const alphas: number[] = []
    const addColormap = nv.addColormap.bind(nv)
    nv.addColormap = (name, cmap) => {
      alphas.push(cmap.A?.[1] ?? -1)
      return addColormap(name, cmap)
    }
    registerNiivue('faint', nv)
    const stop = startSegPanel(
      nv,
      'faint',
      { displaySetInstanceUID: 'faint', Modality: 'SEG' },
      [segment(1)],
      managers,
    )
    // round(alpha * 1/255) must stay 1: the shader draws a rim only there.
    expect([alphas.at(-1), nv.drawOpacity]).toEqual([255, 1 / 255])
    stop()
    unregisterNiivue('faint')
    nv.destroy()
  })

  test('volume_onAShearedGrid_isTheAffineDeterminant', async () => {
    const { managers } = host()
    const nv = await viewer([2, 2, 1], [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    // The header's pixDims are the column norms: [1, sqrt 2, 1].
    const pixDims = nv.volumes[0]?.hdr?.pixDims as number[]
    pixDims[2] = Math.SQRT2
    nv.createEmptyDrawing()
    img(nv).set([1, 0, 0, 0])
    registerNiivue('shear', nv)
    const stop = startSegPanel(
      nv,
      'shear',
      { displaySetInstanceUID: 'shear', Modality: 'SEG' },
      [segment(1)],
      managers,
    )
    expect(niivueSegmentationPane('shear')?.rows()[0]?.volume).toBeCloseTo(1)
    stop()
    unregisterNiivue('shear')
    nv.destroy()
  })

  test('twoPanesOnOneSeg_shareAnEdit_itsUndo_andTheSavedCount', async () => {
    const { managers, memos } = host()
    const pane = async (viewportId: string, drawn: number[]) => {
      const nv = await viewer()
      nv.createEmptyDrawing()
      img(nv).set(drawn)
      registerNiivue(viewportId, nv)
      const stop = startSegPanel(
        nv,
        viewportId,
        { displaySetInstanceUID: 'shared', Modality: 'SEG' },
        [segment(1)],
        managers,
      )
      return {
        nv,
        stop: () => {
          stop()
          unregisterNiivue(viewportId)
        },
      }
    }
    const stroke = (nv: NiiVue, i: number) => {
      img(nv)[i] = 1
      nv.emit('drawingChanged', { action: 'stroke' })
      nv.emit('pointerUp', {} as never)
    }
    const a = await pane('a', [1, 0, 0, 0])
    stroke(a.nv, 2)
    // B joins after that edit: its SEG load lacks it.
    const b = await pane('b', [1, 0, 0, 0])
    stroke(b.nv, 1)
    expect([...img(a.nv)]).toEqual([1, 1, 1, 0])
    expect(niivueSegmentationPane('shared')?.rows()[0]?.count).toBe(3)
    memos[1]?.restoreMemo(true)
    expect([...img(a.nv), ...img(b.nv)]).toEqual([1, 0, 1, 0, 1, 0, 1, 0])
    b.stop()
    a.stop()
  })

  test('deleteSegment_undo_reachesSurvivingPanes_notAReplacement', async () => {
    const { managers, memos, segs } = host()
    const pane = async (viewportId: string, seg: string) => {
      const nv = await viewer()
      nv.createEmptyDrawing()
      img(nv).set([1, 2, 0, 1])
      registerNiivue(viewportId, nv)
      const stop = startSegPanel(
        nv,
        viewportId,
        { displaySetInstanceUID: seg, Modality: 'SEG' },
        [segment(1), segment(2)],
        managers,
      )
      return { nv, stop }
    }
    const a = await pane('del-a', 'del')
    const b = await pane('del-b', 'del')
    getSegCommandDefinitions(managers).deleteSegment.commandFn({
      segmentationId: 'del',
      segmentIndex: 1,
    })
    const listed = () => Object.keys(segs.get('del')?.segments ?? {})
    expect([listed(), [...img(b.nv)]]).toEqual([['2'], [0, 2, 0, 0]])
    expect(memos).toHaveLength(1)
    // The deleting pane closes; its peer still shows the SEG.
    a.stop()
    memos[0]?.restoreMemo(true)
    expect([listed(), [...img(b.nv)]]).toEqual([
      ['1', '2'],
      [1, 2, 0, 1],
    ])
    memos[0]?.restoreMemo(false)
    expect([listed(), [...img(b.nv)]]).toEqual([['2'], [0, 2, 0, 0]])
    // The deleting pane's controller loads another SEG.
    b.stop()
    img(a.nv).fill(0)
    const stop = startSegPanel(
      a.nv,
      'del-a',
      { displaySetInstanceUID: 'other', Modality: 'SEG' },
      [segment(1)],
      managers,
    )
    memos[0]?.restoreMemo(true)
    expect([...img(a.nv)]).toEqual([0, 0, 0, 0])
    stop()
    unregisterNiivue('del-a')
    unregisterNiivue('del-b')
  })

  test('segExport_ofTheSecondOrthogonalLocalizer_takesItsOrientation', async () => {
    const { managers } = host()
    // The coronal localizer: RAS voxel (x, 0, z) at LPS (2 - x, 0, z).
    const nv = await viewer([3, 1, 3], [1, 0, 0, -2, 0, 1, 0, 0, 0, 0, 1, 0])
    const source = {
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      StudyInstanceUID: '1.2',
      SeriesInstanceUID: '1.2.3',
      FrameOfReferenceUID: '1.2.9',
      ImagePositionPatient: [0, 0, 0],
      PixelSpacing: [1, 1],
      Rows: 3,
      Columns: 3,
    }
    const instances = [
      {
        ...source,
        SOPInstanceUID: '1.2.3.1',
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      },
      {
        ...source,
        SOPInstanceUID: '1.2.3.2',
        ImageOrientationPatient: [1, 0, 0, 0, 0, 1],
      },
    ]
    registerNiivue('localizer', nv)
    updateNiivueViewport('localizer', {
      displaySets: [{ displaySetInstanceUID: 'loc', instances }],
      sliceFrames: {
        origin: [0, 0, 0],
        normal: [0, 1, 0],
        frames: [{ SOPInstanceUID: '1.2.3.2', frameNumber: 1 }],
      },
    })
    const id = getSegCommandDefinitions(
      managers,
    ).createLabelmapForViewport.commandFn({ viewportId: 'localizer' }) as string
    img(nv)[1 + 3] = 1 // LPS (1, 0, 1)
    const pane = niivueSegmentationPane(id)
    // biome-ignore lint/suspicious/noExplicitAny: a naturalized dcmjs dataset
    const ds: any =
      pane && (await niivueSegmentationDataset(pane, 'SEG', 'paint'))
    const iop =
      ds?.SharedFunctionalGroupsSequence.PlaneOrientationSequence
        .ImageOrientationPatient
    const frame = ds?.PerFrameFunctionalGroupsSequence[0]
    expect(iop).toEqual([1, 0, 0, 0, 0, 1])
    expect(
      frame.DerivationImageSequence.SourceImageSequence
        .ReferencedSOPInstanceUID,
    ).toBe('1.2.3.2')
    const ipp = frame.PlanePositionSequence.ImagePositionPatient as number[]
    expect(ipp.map((v, axis) => v + iop[axis] + iop[axis + 3])).toEqual([
      1, 0, 1,
    ])
    nv.closeDrawing()
    unregisterNiivue('localizer')
  })

  test('a cancelled stroke keeps the locked segment and records its edit', async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    const canvas = new EventTarget()
    nv.canvas = canvas as never
    await nv.loadVolumes([{ url: nifti([2, 1, 1], IDENTITY) }])
    nv.createEmptyDrawing()
    const img = nv.drawingVolume?.img as Uint8Array
    img[0] = 1
    let edits = 0
    const stop = startSegEditing(nv, {
      locked: () => new Set([1]),
      onEdit: () => edits++,
    })
    // Core's pen paints during the drag and emits nothing until pointerup.
    nv.drawIsEnabled = true
    img[0] = 2
    img[1] = 2
    canvas.dispatchEvent(new Event('pointercancel'))
    expect(Array.from(img)).toEqual([1, 2])
    expect(edits).toBe(1)
    stop()
  })
})
