import NiiVue from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset, canvases }) => {
  const nv1 = new NiiVue()
  const nv2 = new NiiVue()
  await nv1.attachToCanvas(canvas)
  await nv2.attachToCanvas(canvases[1])
  await nv1.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])
  await nv2.loadVolumes([
    { url: asset('volumes/mni152.nii.gz'), colormap: 'hot' },
  ])

  const link = (mode: string): void => {
    nv1.broadcastTo(mode === 'Independent' ? undefined : [nv2])
    nv2.broadcastTo(mode === 'Both ways' ? [nv1] : undefined)
  }
  link('Both ways')
  ui.select(
    'Link',
    ['Both ways', 'Left drives right', 'Independent'],
    'Both ways',
    link,
  )
  return [nv1, nv2]
}

export default demo
