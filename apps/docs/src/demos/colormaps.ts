import NiiVue from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ isColorbarVisible: true })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])

  // A custom colormap (black, blue, white); it joins nv.colormaps as 'Icy'
  nv.addColormap('icy', {
    R: [0, 0, 255],
    G: [0, 128, 255],
    B: [0, 255, 255],
  })

  const vol = nv.volumes[0]
  const lo = vol.globalMin
  const hi = vol.globalMax
  const step = (hi - lo) / 200

  ui.select('Colormap', nv.colormaps, 'Gray', async (name) => {
    await nv.setVolume(0, { colormap: name })
  })
  ui.slider(
    'Min',
    lo,
    hi,
    vol.calMin,
    async (v) => {
      await nv.setVolume(0, { calMin: v })
    },
    step,
  )
  ui.slider(
    'Max',
    lo,
    hi,
    vol.calMax,
    async (v) => {
      await nv.setVolume(0, { calMax: v })
    },
    step,
  )
  ui.checkbox('Invert', false, async (on) => {
    await nv.setVolume(0, { isColormapInverted: on })
  })
  ui.checkbox('Colorbar', true, (on) => {
    nv.isColorbarVisible = on
  })
  return nv
}

export default demo
