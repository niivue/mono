import { expect, it } from 'bun:test'
import NiiVue from '@niivue/niivue'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { armBrush, getQuantCommandDefinitions } from './petQuant'

// 2x2x2 uint8 NIfTI-1, 1 mm voxels.
function nifti(): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [3, 2, 2, 2].entries()) hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 2, true)
  hdr.setInt16(72, 8, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true) // magic 'n+1'
  return new File([hdr.buffer, new Uint8Array(8).fill(5)], 'pet.nii')
}

// Audit 22.3: Add Segment / segment selection must retarget an armed brush;
// an armed eraser keeps painting 0.
it('segment change retargets an armed brush pen, not an eraser', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti() }])
  registerNiivue('pet', nv)
  updateNiivueViewport('pet', {
    displaySets: [{ displaySetInstanceUID: 'pt', Modality: 'PT' } as never],
  })
  const services = {
    services: { viewportGridService: { getActiveViewportId: () => 'pet' } },
  } as never
  const cmd = getQuantCommandDefinitions({
    servicesManager: services,
  } as never) as unknown as Record<string, { commandFn: (o: object) => void }>
  expect(armBrush('pet', 'CircularBrush', services)).toBe(true)
  cmd.niivueAddSegment?.commandFn({})
  expect(nv.drawPenValue).toBe(2)
  armBrush('pet', 'CircularEraser', services)
  cmd.niivueSetActiveSegment?.commandFn({ segmentIndex: 1 })
  expect(nv.drawPenValue).toBe(0)
  unregisterNiivue('pet')
})
