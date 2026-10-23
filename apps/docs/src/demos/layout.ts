import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const mosaic = 'A -20 0 20 40 ; C -30 0 30 S R X 0'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ backgroundColor: [0.2, 0.2, 0.2, 1] })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])

  ui.select(
    'View',
    [
      ['Axial', String(SLICE_TYPE.AXIAL)],
      ['Coronal', String(SLICE_TYPE.CORONAL)],
      ['Sagittal', String(SLICE_TYPE.SAGITTAL)],
      ['Multiplanar', String(SLICE_TYPE.MULTIPLANAR)],
      ['Render', String(SLICE_TYPE.RENDER)],
      ['Mosaic', 'mosaic'],
    ],
    String(SLICE_TYPE.MULTIPLANAR),
    (v) => {
      if (v === 'mosaic') {
        nv.mosaicString = mosaic
        return
      }
      nv.mosaicString = ''
      nv.sliceType = Number(v)
    },
  )
  ui.select(
    'Multiplanar',
    [
      ['Auto', String(MULTIPLANAR_TYPE.AUTO)],
      ['Column', String(MULTIPLANAR_TYPE.COLUMN)],
      ['Grid', String(MULTIPLANAR_TYPE.GRID)],
      ['Row', String(MULTIPLANAR_TYPE.ROW)],
    ],
    String(MULTIPLANAR_TYPE.AUTO),
    (v) => {
      nv.multiplanarType = Number(v)
    },
  )
  return nv
}

export default demo
