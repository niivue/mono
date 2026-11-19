import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'

const SPHERE = devImageUrl('volumes/sphere.nii.gz')

// Holistic review H4: the outline takes alpha < 1 as below threshold, so an
// overlay keeping its colormap's alpha ramp got black edges inside its window.
test('the 2D overlay outline is off while an overlay keeps its colormap alpha', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }, { url: SPHERE }])
  nv.volumeOutlineWidth = 2
  expect(nv.model.overlayOutlineWidth()).toBe(2)
  await nv.setVolume(1, { isColormapAlphaKept: true })
  expect(nv.model.overlayOutlineWidth()).toBe(0)
  await nv.setVolume(0, { isColormapAlphaKept: true })
  await nv.setVolume(1, { isColormapAlphaKept: false })
  expect(nv.model.overlayOutlineWidth()).toBe(2) // the base is not an overlay
  // Review of #865: a hidden overlay is not drawn, so it does not turn the
  // outline off for the rest.
  await nv.setVolume(1, { isColormapAlphaKept: true, visible: false })
  expect(nv.model.overlayOutlineWidth()).toBe(2)
  await nv.setVolume(1, { visible: true, opacity: 0 })
  expect(nv.model.overlayOutlineWidth()).toBe(2)
})
