import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

// Each plane is [depth, azimuth, elevation]
const presets: Record<string, number[][]> = {
  None: [],
  One: [[0.1, 180, 20]],
  Two: [
    [0.1, 180, 20],
    [0.1, 0, -20],
  ],
  Three: [
    [0, 90, 0],
    [0, 0, -20],
    [0.1, 0, -90],
  ],
}

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ sliceType: SLICE_TYPE.RENDER })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  nv.setClipPlanes(presets.Two)

  ui.select('Planes', Object.keys(presets), 'Two', (name) => {
    nv.setClipPlanes(presets[name])
  })
  ui.checkbox('Cutaway', false, (on) => {
    nv.isClipPlaneCutaway = on
  })
  ui.select(
    'Cut surface',
    ['transparent', 'translucent', 'shaded'],
    'translucent',
    (v) => {
      const alpha = v === 'transparent' ? 0 : v === 'translucent' ? 0.3 : -0.2
      nv.clipPlaneColor = [0.7, 0, 0.7, alpha]
    },
  )
  return nv
}

export default demo
