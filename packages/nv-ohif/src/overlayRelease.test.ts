import { expect, spyOn, test } from 'bun:test'
import { getNiivueCommandsModule } from './commands'
import * as conversion from './dicomToNiivue'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'
import { clearSharedTasks, sharedTask, sharedTaskCount } from './sharedTask'

// Regression (external audit R2-5): a finished DICOM overlay must release its
// shared conversion, or the module cache keeps the image after unmount.
test('a completed DICOM overlay releases its shared conversion', async () => {
  clearSharedTasks()
  let callerSignal: AbortSignal | undefined
  const convert = spyOn(
    conversion,
    'convertDisplaySetToNifti',
  ).mockImplementation((_ds, options) => {
    callerSignal = options?.signal
    return sharedTask(
      'overlay-release',
      async () => ({ image: new File(['payload'], 'overlay.nii') }),
      options,
    )
  })
  const nv = {
    volumes: [{ hdr: {} }] as unknown[],
    prepareVolume: async (spec: object) => ({ ...spec, hdr: {} }),
    addVolume: async (image: unknown) => nv.volumes.push(image),
  }
  registerNiivue('overlay-release', nv as never)
  updateNiivueViewport('overlay-release', {
    displaySets: [{ displaySetInstanceUID: 'base' }],
  })
  const ds = {
    displaySetInstanceUID: 'overlay',
    Modality: 'CT',
    instances: [
      { imageId: 'wadors:https://h/studies/1/series/2/instances/3/frames/1' },
    ],
  }
  const { actions } = getNiivueCommandsModule({
    servicesManager: {
      services: {
        viewportGridService: { getActiveViewportId: () => 'overlay-release' },
        displaySetService: { getActiveDisplaySets: () => [ds] },
      },
    },
  } as unknown as OhifExtensionParams)
  await actions.niivueAddOverlay({ displaySetInstanceUID: 'overlay' })
  expect(getNiivueEntry('overlay-release')?.overlays.size).toBe(1)
  expect(callerSignal?.aborted).toBe(true)
  await new Promise((r) => setTimeout(r, 0))
  expect(sharedTaskCount()).toBe(0)
  unregisterNiivue('overlay-release')
  convert.mockRestore()
})
