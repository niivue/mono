import NiiVue, { SHOW_RENDER } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({
    showRender: SHOW_RENDER.ALWAYS,
    backgroundColor: [0.3, 0.3, 0.5, 1],
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    { url: asset('volumes/mni152.nii.gz'), calMin: 30, calMax: 80 },
    { url: asset('volumes/aal.nii.gz'), opacity: 0.5 },
  ])
  // Turn the integer volume into a labeled atlas
  await nv.setColormapLabelFromUrl(1, asset('volumes/aal.json'))

  const show = ui.status('Click a region')
  nv.addEventListener('locationChange', (e) => {
    show(e.detail.values[1]?.label ?? 'no region')
  })

  ui.slider(
    'Opacity',
    0,
    1,
    0.5,
    async (v) => {
      await nv.setVolume(1, { opacity: v })
    },
    0.05,
  )
  ui.slider('Outline', 0, 3, 0, (v) => {
    nv.setAtlasOutline(v, 1)
  })
  ui.checkbox('Hide dark voxels', false, (on) => {
    nv.volumeIsAlphaClipDark = on
  })
  return nv
}

export default demo
