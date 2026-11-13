import NiiVue, { SHOW_RENDER, VOLUME_RENDER_MODE } from '@niivue/niivue'
import type { Demo } from './types'

const CT_ABDO =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/CT_Abdo.nii.gz'

const demo: Demo = async (canvas, { ui }) => {
  const nv = new NiiVue({
    isColorbarVisible: true,
    showRender: SHOW_RENDER.ALWAYS,
    is3DCrosshairVisible: true,
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: CT_ABDO, colormap: 'ct_kidneys' }])

  // Stored names are capitalized ('Ct_kidneys'); lookups accept either case.
  const maps = nv.colormapNames('continuous').filter((n) => /^ct_/i.test(n))
  ui.select('Colormap', maps, 'Ct_kidneys', async (name) => {
    await nv.setVolume(0, { colormap: name })
  })
  ui.checkbox('Invert', false, async (on) => {
    await nv.setVolume(0, { isColormapInverted: on })
  })
  ui.checkbox('Clip dark', false, (on) => {
    nv.volumeIsAlphaClipDark = on
  })
  ui.slider(
    'Gamma',
    0.1,
    3,
    nv.gamma,
    (v) => {
      nv.gamma = v
    },
    0.1,
  )
  ui.select(
    'Render',
    [
      ['slices', 'slices'],
      ['matte', '0'],
      ['glossy', '0.6'],
    ],
    '0',
    (v) => {
      if (v === 'slices') {
        nv.volumeRenderMode = VOLUME_RENDER_MODE.SLICES
        return
      }
      nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
      nv.volumeIllumination = Number(v)
    },
  )
  return nv
}

export default demo
