import { expect, it } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
} from './niivueRegistry'
import { cineStep } from './sliceCine'

// 1x1x3 uint8 NIfTI-1: three axial slices.
function nifti(): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [3, 1, 1, 3].entries()) hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 2, true)
  hdr.setInt16(72, 8, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true)
  return new File([hdr.buffer, new Uint8Array(3)], 'stack.nii')
}

it('slice cine loops back to the first slice after the last', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti() }])
  nv.sliceType = SLICE_TYPE.AXIAL
  registerNiivue('cine', nv)
  const entry = getNiivueEntry('cine') as NonNullable<
    ReturnType<typeof getNiivueEntry>
  >
  nv.moveCrosshairInVox(0, 0, -10)
  const z = () => Math.floor((nv.crosshairPos[2] ?? 0) * 3)
  const seen = [z()]
  for (let i = 0; i < 3; i++) {
    cineStep(entry)
    seen.push(z())
  }
  expect(seen).toEqual([0, 1, 2, 0])
  unregisterNiivue('cine')
})
