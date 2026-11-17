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

// A CT pane narrower than the PT grid (2 vs 3 voxels) with the PT overlaid.
function fusion() {
  const affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  const vol = (n: number, hdr: object) => ({
    img: new Float32Array(n),
    dimsRAS: [3, n, 1, 1],
    img2RASstep: [1, n, n],
    img2RASstart: [0, 0, 0],
    matRAS: affine,
    hdr,
  })
  const pane = (volumes: object[]) =>
    Object.assign(new EventTarget(), {
      volumes,
      drawingVolume: undefined as undefined | { img: Uint8Array },
      drawIsEnabled: false,
      createEmptyDrawing() {
        this.drawingVolume = {
          img: new Uint8Array((volumes[0] as { img: Float32Array }).img.length),
        }
      },
      refreshDrawing() {},
    })
  const ptHdr = {}
  const pt = pane([vol(3, ptHdr)])
  const ct = pane([vol(2, {}), vol(3, ptHdr)])
  registerNiivue('fpt', pt as never)
  registerNiivue('fct', ct as never)
  updateNiivueViewport('fpt', {
    displaySets: [{ displaySetInstanceUID: 'pet', Modality: 'PT' }] as never,
  })
  updateNiivueViewport('fct', {
    displaySets: [{ displaySetInstanceUID: 'ct', Modality: 'CT' }] as never,
    overlays: new Map([['pet', ptHdr]]) as never,
  })
  const services = {
    services: {
      displaySetService: {
        getDisplaySetByUID: () => ({
          displaySetInstanceUID: 'pet',
          Modality: 'PT',
        }),
      },
    },
  } as never
  armBrush('fpt', 'CircularBrush', services)
  const cmd = getQuantCommandDefinitions({
    servicesManager: services,
  } as never) as unknown as Record<string, { commandFn: () => unknown }>
  const mask = (cmd.niivueGetLabelmap?.commandFn() as { label: Uint8Array })
    .label
  const stroke = () => {
    if (!ct.drawingVolume) throw new Error('no CT drawing')
    ct.drawingVolume.img[0] = 2
    ct.dispatchEvent(
      new CustomEvent('drawingChanged', { detail: { action: 'stroke' } }),
    )
  }
  const done = () => {
    unregisterNiivue('fpt')
    unregisterNiivue('fct')
  }
  return { services, mask, stroke, done }
}

it('a CT pane stroke keeps PET labels outside the CT field of view', () => {
  const f = fusion()
  try {
    f.mask.set([1, 1, 1])
    armBrush('fct', 'CircularBrush', f.services)
    f.stroke()
    expect([...f.mask]).toEqual([2, 1, 1])
  } finally {
    f.done()
  }
})

it('a threshold brush stays armed when another pane arms a plain brush', () => {
  const f = fusion()
  try {
    f.mask.fill(0)
    armBrush('fct', 'ThresholdCircularBrush', f.services)
    armBrush('fpt', 'CircularBrush', f.services)
    // PT is 0 everywhere, below the default [2.5, 50] range.
    f.stroke()
    expect([...f.mask]).toEqual([0, 0, 0])
  } finally {
    f.done()
  }
})
