import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

// Community MSDF fonts from github.com/niivue/fonts (served with CORS).
const FONTS = 'https://raw.githubusercontent.com/niivue/fonts/main/fonts/'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({
    sliceType: SLICE_TYPE.AXIAL,
    isColorbarVisible: true,
    fontColor: [1, 1, 1, 1],
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  const show = ui.status()
  nv.addEventListener('locationChange', (e) => show(e.detail.string))

  ui.select(
    'Font',
    ['Ubuntu', 'UbuntuBold', 'Roboto-Regular', 'Garamond', 'GaramondBold'],
    'Ubuntu',
    async (name) => {
      await nv.setFontFromUrl({
        atlas: `${FONTS}${name}.png`,
        metrics: `${FONTS}${name}.json`,
      })
    },
  )
  ui.slider(
    'Size',
    0.1,
    1,
    nv.fontScale,
    (v) => {
      nv.fontScale = v
      nv.resize() // text size is computed when the view is laid out
    },
    0.05,
  )
  return nv
}

export default demo
