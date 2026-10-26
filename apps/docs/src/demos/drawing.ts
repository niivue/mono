import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ sliceType: SLICE_TYPE.AXIAL, drawPenSize: 3 })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  nv.createEmptyDrawing()

  ui.checkbox('Draw', true, (on) => {
    nv.drawIsEnabled = on
  })
  ui.select(
    'Pen',
    [
      ['Red', '1'],
      ['Green', '2'],
      ['Blue', '3'],
      ['Erase', '0'],
    ],
    '1',
    (v) => {
      nv.drawPenValue = Number(v)
    },
  )
  ui.checkbox('Filled', false, (on) => {
    nv.drawPenFilled = on
    nv.drawPenAutoClose = on
  })
  ui.button('Undo', () => nv.drawUndo())
  return nv
}

export default demo
