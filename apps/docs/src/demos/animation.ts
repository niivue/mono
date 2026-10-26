import type { AnimationOptions, AnimationTarget } from '@niivue/niivue'
import NiiVue, { SHOW_RENDER } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ showRender: SHOW_RENDER.ALWAYS })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    { url: asset('volumes/mni152.nii.gz') },
    {
      url: asset('volumes/mni152_gm.nii.gz'),
      colormap: 'warm',
      calMin: 0.5,
      calMax: 1,
      opacity: 0,
    },
  ])
  // Depth 2 puts the clip plane outside the volume, so nothing is cut.
  const home: AnimationTarget = {
    azimuth: 110,
    elevation: 15,
    clipPlanes: { 0: [2, 270, 0] },
    volumes: { 1: { opacity: 0 } },
  }
  await nv.animateTo(home, { duration: 0 })

  const show = ui.status('Drag or scroll the canvas to interrupt a move.')
  const run = async (target: AnimationTarget, options?: AnimationOptions) => {
    const result = await nv.animateTo(target, { duration: 1500, ...options })
    show(`${result.reason} after ${Math.round(result.elapsedMs)} ms`)
  }

  ui.button('Turn', () => run({ azimuth: 200, elevation: 35 }))
  ui.button('Cut', () => run({ clipPlanes: { 0: [0, 270, 0] } }))
  ui.button('Fade in', () => run({ volumes: { 1: { opacity: 0.8 } } }))
  ui.button('Spin', () =>
    run(
      { azimuth: nv.azimuth + 360 },
      { duration: 4000, angles: 'literal', easing: 'linear' },
    ),
  )
  ui.button('Home', () => run(home))
  ui.button('Stop', () => nv.stopAnimation())
  return nv
}

export default demo
