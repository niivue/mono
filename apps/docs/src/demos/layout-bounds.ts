import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv1 = new NiiVue({
    bounds: [
      [0, 0],
      [0.5, 1],
    ],
    showBoundsBorder: true,
  })
  const nv2 = new NiiVue({
    bounds: [
      [0.5, 0],
      [1, 1],
    ],
    showBoundsBorder: true,
  })
  await nv1.attachToCanvas(canvas)
  await nv2.attachToCanvas(canvas)
  await nv1.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  await nv2.loadVolumes([
    { url: asset('volumes/mni152.nii.gz'), colormap: 'hot' },
  ])
  nv1.sliceType = SLICE_TYPE.AXIAL
  nv2.sliceType = SLICE_TYPE.RENDER

  ui.select('Split', ['Side by side', 'Stacked'], 'Side by side', (v) => {
    // [x1, y1, x2, y2], with y = 0 at the bottom of the canvas
    const stacked = v === 'Stacked'
    nv1.setBounds(stacked ? [0, 0.5, 1, 1] : [0, 0, 0.5, 1])
    nv2.setBounds(stacked ? [0, 0, 1, 0.5] : [0.5, 0, 1, 1])
  })
  return [nv1, nv2]
}

export default demo
