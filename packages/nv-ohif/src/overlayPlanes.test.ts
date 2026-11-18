import { expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import type { OhifExtensionManager } from './ohif-types'
import { setOverlayPlanes } from './overlayPlanes'

// A tool group with ImageOverlayViewer Enabled.
const em = {
  getModuleEntry: () => ({
    exports: {
      getCornerstoneLibraries: () => ({
        cornerstoneTools: {
          ToolGroupManager: {
            getToolGroup: () => ({
              getToolInstance: () => ({ mode: 'Enabled' }),
            }),
          },
        },
      }),
    },
  }),
} as unknown as OhifExtensionManager

// Review of #857: an image switch while a plane loads must not leave it shown.
test('a plane still loading when the image changes is dropped', async () => {
  let finish: (ok: boolean) => void = () => {}
  const nv = {
    drawingVolume: null as unknown,
    loadDrawing: () =>
      new Promise<boolean>((resolve) => {
        finish = (ok) => {
          nv.drawingVolume = {}
          resolve(ok)
        }
      }),
    closeDrawing: () => {
      nv.drawingVolume = null
    },
  }
  const old = new File([], 'old_ROI1.nii')
  const loading = setOverlayPlanes(nv as unknown as NiiVue, [old], em, 'g')
  await setOverlayPlanes(nv as unknown as NiiVue, undefined, em, 'g')
  finish(true)
  await loading
  expect(nv.drawingVolume).toBeNull()
})
