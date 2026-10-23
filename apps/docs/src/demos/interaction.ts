import NiiVue, { DRAG_MODE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ backgroundColor: [0.2, 0.2, 0.2, 1] })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: asset('volumes/mni152.nii.gz') }])

  ui.select(
    'Left drag',
    [
      ['crosshair', String(DRAG_MODE.crosshair)],
      ['crosshairPan', String(DRAG_MODE.crosshairPan)],
      ['pan', String(DRAG_MODE.pan)],
      ['contrast', String(DRAG_MODE.contrast)],
      ['measurement', String(DRAG_MODE.measurement)],
      ['angle', String(DRAG_MODE.angle)],
    ],
    String(DRAG_MODE.crosshair),
    (v) => {
      nv.primaryDragMode = Number(v)
    },
  )

  const show = ui.status('Click or drag on a slice')
  nv.addEventListener('locationChange', (e) => show(e.detail.string))
  nv.addEventListener('dragRelease', (e) => {
    show(`dragRelease: ${e.detail.mmLength.toFixed(1)} mm`)
  })
  nv.addEventListener('measurementCompleted', (e) => {
    show(`measurementCompleted: ${e.detail.distance.toFixed(1)} mm`)
  })
  nv.addEventListener('angleCompleted', (e) => {
    show(`angleCompleted: ${e.detail.angle.toFixed(1)} degrees`)
  })
  return nv
}

export default demo
