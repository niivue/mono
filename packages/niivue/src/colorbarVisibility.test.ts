import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'

// A hidden or zero-opacity volume must not leave its colorbar behind.
test('hidden and zero-opacity volumes drop their colorbar', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  const count = () => nv.model.collectColorbars().length
  expect(count()).toBe(1)
  await nv.setVolume(0, { opacity: 0 })
  expect(count()).toBe(0)
  await nv.setVolume(0, { opacity: 1, visible: false })
  expect(count()).toBe(0)
  await nv.setVolume(0, { visible: true })
  expect(count()).toBe(1)
})
