import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.MULTIPLANAR,
  })
  await nv.attachToCanvas(canvas)
  // The first volume is the background; later ones are drawn on top of it
  await nv.loadVolumes([
    {
      url: asset('volumes/mni152.nii.gz'),
      calMin: 30,
      calMax: 80,
      isColorbarVisible: false,
    },
    {
      url: asset('volumes/spmMotor.nii.gz'),
      name: 'motor',
      colormap: 'warm',
      calMin: 3,
      calMax: 6,
      opacity: 0.8,
    },
  ])

  ui.slider(
    'Opacity',
    0,
    1,
    0.8,
    async (v) => {
      await nv.setVolume(1, { opacity: v })
    },
    0.05,
  )
  ui.checkbox('Visible', true, async (on) => {
    await nv.setVolume(1, { visible: on })
  })
  return nv
}

export default demo
