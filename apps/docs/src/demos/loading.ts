import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({
    backgroundColor: [0.2, 0.2, 0.2, 1],
    sliceType: SLICE_TYPE.MULTIPLANAR,
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])

  const show = ui.status()
  nv.addEventListener('locationChange', (e) => show(e.detail.string))

  // loadVolumes replaces every loaded volume with the new list
  ui.select(
    'Volume',
    [
      ['mni152 (NIfTI)', 'volumes/mni152.nii.gz'],
      ['visiblehuman (NIfTI)', 'volumes/visiblehuman.nii.gz'],
      ['wm (MGZ)', 'volumes/wm.mgz'],
    ],
    'volumes/mni152.nii.gz',
    async (path) => {
      await nv.loadVolumes([{ url: asset(path) }])
    },
  )
  return nv
}

export default demo
