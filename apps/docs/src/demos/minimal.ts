import NiiVue from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { asset }) => {
  const nv = new NiiVue()
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  return nv
}

export default demo
