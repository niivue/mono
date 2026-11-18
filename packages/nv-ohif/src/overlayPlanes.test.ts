import { expect, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { DEFAULT_OPTIONS } from './NiivueViewport'
import type { OhifExtensionManager } from './ohif-types'
import {
  holdOverlayPlanes,
  planeFrame,
  refreshOverlayPlanes,
  setOverlayPlanes,
} from './overlayPlanes'
import { startSegDrawing } from './segDrawing'

// A tool group with ImageOverlayViewer in `mode.value`.
function toolGroup(mode = { value: 'Enabled' }) {
  return {
    getModuleEntry: () => ({
      exports: {
        getCornerstoneLibraries: () => ({
          cornerstoneTools: {
            ToolGroupManager: {
              getToolGroup: () => ({
                getToolInstance: () => ({ mode: mode.value }),
              }),
            },
          },
        }),
      },
    }),
  } as unknown as OhifExtensionManager
}
const em = toolGroup()

// Core's drawing calls as overlayPlanes sees them: every load, install, cancel
// or close bumps drawingGeneration, and a load installs only if none came
// after it. `finish` settles the latest load.
function fakeCore(options: { autoFinish?: boolean } = {}) {
  let finish: () => void = () => {}
  let onFrame: () => void = () => {}
  const nv = {
    drawingVolume: null as unknown,
    drawingGeneration: 0,
    volumes: [] as { frame4D?: number }[],
    addEventListener: (_type: string, fn: () => void) => {
      onFrame = fn
    },
    drawIsEnabled: false,
    loadDrawing: () => {
      const generation = ++nv.drawingGeneration
      nv.drawIsEnabled = true
      const done = new Promise<boolean>((resolve) => {
        finish = () => {
          const ok = nv.drawingGeneration === generation
          if (ok) nv.drawingVolume = {}
          resolve(ok)
        }
      })
      if (options.autoFinish) finish()
      return done
    },
    cancelDrawingLoad: () => {
      nv.drawingGeneration++
    },
    closeDrawing: () => {
      nv.drawingGeneration++
      nv.drawingVolume = null
    },
  }
  return {
    nv,
    as: nv as unknown as NiiVue,
    finish: () => finish(),
    stepFrame: (frame: number) => {
      nv.volumes = [{ frame4D: frame }]
      onFrame()
    },
  }
}
const plane = () => [new File([], 'x_ROI1.nii')]

// Review of #857: an image switch while a plane loads must not leave it shown.
test('a plane still loading when the image changes is dropped', async () => {
  const core = fakeCore()
  const loading = setOverlayPlanes(core.as, plane(), em, 'g')
  await setOverlayPlanes(core.as, undefined, em, 'g')
  core.finish()
  await loading
  expect(core.nv.drawingVolume).toBeNull()
})

// User report: series 401 painted into its overlay plane on a plain drag.
test('a shown overlay plane leaves the pen off', async () => {
  const core = fakeCore({ autoFinish: true })
  await setOverlayPlanes(core.as, plane(), em, 'g')
  expect(core.nv.drawingVolume).not.toBeNull()
  expect(core.nv.drawIsEnabled).toBe(false)
})

// Review of #863: a segmentation made during the plane's load keeps its pen.
test('a superseded plane load leaves the pen armed', async () => {
  const core = fakeCore()
  const pending = setOverlayPlanes(core.as, plane(), em, 'g')
  core.nv.closeDrawing() // the segmentation's install
  core.nv.drawingVolume = {}
  core.nv.drawIsEnabled = true
  core.finish()
  await pending
  expect(core.nv.drawIsEnabled).toBe(true)
})

// Holistic review H3: turning the planes off leaves a drawing that replaced them.
test('turning planes off closes only the plane drawing', async () => {
  const mode = { value: 'Enabled' }
  const group = toolGroup(mode)
  const core = fakeCore({ autoFinish: true })
  await setOverlayPlanes(core.as, plane(), group, 'g')
  const seg = {}
  core.nv.drawingVolume = seg // a segmentation replaced the plane
  mode.value = 'Disabled'
  await refreshOverlayPlanes(core.as, group, 'g')
  expect(core.nv.drawingVolume).toBe(seg)
})

// H3: a hold drops a plane still loading; the release shows the planes again.
test('a hold cancels a pending plane, its release shows it', async () => {
  const core = fakeCore()
  const files = plane()
  const loading = setOverlayPlanes(core.as, files, em, 'g')
  const release = holdOverlayPlanes(core.as)
  core.finish()
  await loading
  expect(core.nv.drawingVolume).toBeNull()
  await setOverlayPlanes(core.as, files, em, 'g') // held: no load
  expect(core.nv.drawingVolume).toBeNull()
  release()
  core.finish()
  await Promise.resolve()
  expect(core.nv.drawingVolume).not.toBeNull()
})

function labels(): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(352 + 8))
  view.setInt32(0, 348, true)
  ;[3, 2, 2, 2].forEach((d, i) => {
    view.setInt16(40 + 2 * i, d, true)
  })
  view.setInt16(70, 2, true)
  view.setInt16(72, 8, true)
  ;[1, 1, 1, 1].forEach((d, i) => {
    view.setFloat32(76 + 4 * i, d, true)
  })
  view.setFloat32(108, 352, true)
  view.setFloat32(112, 1, true)
  view.setInt16(254, 1, true)
  ;[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].forEach((v, i) => {
    view.setFloat32(280 + 4 * i, v, true)
  })
  ;[0x6e, 0x2b, 0x31, 0].forEach((b, i) => {
    view.setUint8(344 + i, b)
  })
  view.setUint8(352, 1)
  return view.buffer
}

// H3: a SEG hung over a series with 60xx planes shows (the plane load used to
// bump drawingGeneration and the SEG gave way). useSegDrawing holds first.
test('a SEG over a series with overlay planes is shown', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const nv = new NiiVue(DEFAULT_OPTIONS)
  let installBase: (ok: boolean) => void = () => {}
  const whenBase = new Promise<boolean>((r) => {
    installBase = r
  })
  const release = holdOverlayPlanes(nv)
  const stop = startSegDrawing(
    nv,
    { displaySetInstanceUID: 'seg', Modality: 'SEG' },
    {
      setNote: () => {},
      convert: async () =>
        ({
          image: new File([labels()], 'seg.nii'),
          json: { Segments: [{ LabelValue: 1, RGB: [1, 2, 3] }] },
        }) as never,
      whenBase,
    },
  )
  await nv.loadVolumes([{ url: new File([labels()], 'base.nii') }])
  void setOverlayPlanes(nv, [new File([labels()], 'base_ROI1.nii')], em, 'g')
  installBase(true)
  for (let i = 0; i < 50 && nv.drawColormap.toLowerCase() !== 'seg-seg'; i++)
    await new Promise((r) => setTimeout(r, 10))
  expect(nv.drawColormap.toLowerCase()).toBe('seg-seg')
  stop()
  release()
})

// A uint8 NIfTI-1 plane of `frames` 2x1x1 volumes; volume t holds t + 1.
function plane4D(frames: number): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, v] of [4, 2, 1, 1, frames].entries())
    hdr.setInt16(40 + 2 * i, v, true)
  hdr.setInt16(70, 2, true)
  hdr.setFloat32(108, 352, true)
  const data = Uint8Array.from({ length: 2 * frames }, (_, i) => (i >> 1) + 1)
  return new File([hdr.buffer, data], 'x_ROI1.nii')
}

// Review of #863: a 4D plane showed its first frame whatever the pane showed.
test('planeFrame cuts volume t of a 4D plane as a 3D plane', async () => {
  const cut = new DataView(
    await (await planeFrame(plane4D(3), 2)).arrayBuffer(),
  )
  expect(cut.getInt16(40, true)).toBe(3)
  expect(cut.getInt16(48, true)).toBe(1)
  expect([cut.getUint8(352), cut.getUint8(353)]).toEqual([3, 3])
  expect(cut.byteLength).toBe(354)
  const flat = plane4D(1)
  expect(await planeFrame(flat, 1)).toBe(flat)
})

test('a 4D plane reloads for the frame the pane steps to', async () => {
  const core = fakeCore({ autoFinish: true })
  const loads: File[] = []
  const load = core.nv.loadDrawing
  core.nv.loadDrawing = ((f: File) => {
    loads.push(f)
    return load()
  }) as typeof core.nv.loadDrawing
  const file = plane4D(2)
  await setOverlayPlanes(core.as, [file], em, 'g')
  expect(loads).toEqual([file])
  core.stepFrame(1)
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(loads.length).toBe(2)
  expect(new Uint8Array(await (loads[1] as File).arrayBuffer())[352]).toBe(2)
  expect(core.nv.drawingVolume).not.toBeNull()
})
