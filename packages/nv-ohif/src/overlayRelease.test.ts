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
import { clearSharedTasks, sharedTask } from './sharedTask'

// Regression (external audit R2-5): a finished DICOM overlay must release its
// hold on the shared conversion; retention after release is bounded in sharedTask.
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
  unregisterNiivue('overlay-release')
  convert.mockRestore()
})
