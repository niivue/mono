import NiiVue, { SHOW_RENDER } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({
    isColorbarVisible: true,
    showRender: SHOW_RENDER.ALWAYS,
    backgroundColor: [0.1, 0.1, 0.1, 1],
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    {
      url: asset('volumes/mni152.nii.gz'),
      calMin: 30,
      calMax: 80,
      isColorbarVisible: false,
    },
    {
      url: asset('volumes/spmMotor.nii.gz'),
      colormap: 'redyell',
      colormapNegative: 'winter',
    },
  ])

  let pos = 3
  let neg = 3
  let colormapType = 0
  const update = async () => {
    await nv.setVolume(1, {
      calMin: pos,
      calMax: pos + 3,
      calMinNeg: -neg,
      calMaxNeg: -neg - 3,
      colormapType,
    })
  }
  await update()

  ui.slider(
    '+Thresh',
    1,
    6,
    pos,
    async (v) => {
      pos = v
      await update()
    },
    0.1,
  )
  ui.slider(
    '-Thresh',
    1,
    6,
    neg,
    async (v) => {
      neg = v
      await update()
    },
    0.1,
  )
  // 0: min to max, 1: zero to max (transparent below), 2: zero to max (translucent below)
  ui.select(
    'Mode',
    [
      ['min to max', '0'],
      ['zero to max, transparent', '1'],
      ['zero to max, translucent', '2'],
    ],
    '0',
    async (v) => {
      colormapType = Number(v)
      await update()
    },
  )
  ui.slider(
    'Outline',
    0,
    1,
    0,
    (v) => {
      nv.volumeOutlineWidth = v
    },
    0.25,
  )
  return nv
}

export default demo
