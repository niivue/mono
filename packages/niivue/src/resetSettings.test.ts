import { expect, test } from 'bun:test'
import { snapshotSettings } from '@/documentEvents'
import NiiVue, { SLICE_TYPE } from '@/index'
import { devImageUrl } from '@/testing/headless'

// resetSettings: every setting back to its built-in default whatever ran
// before (scripts, constructor options), data kept, windows to robust range.

const SPHERE = devImageUrl('volumes/sphere.nii.gz')

/** Two differently scripted viewers over the same data. */
async function scripted(variant: 0 | 1): Promise<NiiVue> {
  const nv = new NiiVue({
    backend: 'webgl2',
    isDragDropEnabled: false,
    backgroundColor: variant ? [1, 1, 1, 1] : [0.2, 0, 0, 1],
  })
  await nv.loadVolumes([{ url: SPHERE }])
  nv.sliceType = variant ? SLICE_TYPE.AXIAL : SLICE_TYPE.RENDER
  nv.azimuth = variant ? 33 : 250
  nv.gamma = variant ? 2 : 0.5
  nv.isColorbarVisible = variant === 1
  nv.meshXRay = 0.4
  nv.renderPan = variant ? [0.4, -0.3] : [-0.2, 0.1]
  nv.clipPlaneOverlay = variant === 1
  await nv.setVolume(0, { calMin: variant, calMax: 3 + variant })
  return nv
}

test('two scripted setups reset to the same settings and windows', async () => {
  const a = await scripted(0)
  const b = await scripted(1)
  await a.resetSettings()
  await b.resetSettings()
  expect(snapshotSettings(a.model)).toEqual(snapshotSettings(b.model))
  expect(snapshotSettings(a.model)).toEqual(
    snapshotSettings(new NiiVue({ backend: 'webgl2' }).model),
  )
  for (const nv of [a, b]) {
    const v = nv.volumes[0]
    expect([v.calMin, v.calMax]).toEqual([v.robustMin, v.robustMax])
    // A host that owns drops keeps owning them.
    expect(nv.isDragDropEnabled).toBe(false)
  }
})

test('reset keeps data and per-volume display, and is idempotent', async () => {
  const nv = await scripted(0)
  await nv.setVolume(0, { colormap: 'hot', opacity: 0.6 })
  nv.setClipPlanes([[0.2, 0, 0]])
  const voxels = nv.volumes[0].img
  await nv.resetSettings()
  const once = snapshotSettings(nv.model)
  await nv.resetSettings()
  expect(snapshotSettings(nv.model)).toEqual(once)
  expect(nv.volumes).toHaveLength(1)
  expect(nv.volumes[0].img).toBe(voxels)
  expect([nv.volumes[0].colormap, nv.volumes[0].opacity]).toEqual(['hot', 0.6])
  expect(nv.getClipPlaneDepthAziElev(0)[0]).toBeCloseTo(0.2)
})

test('reset emits a change per changed setting and a volume update', async () => {
  const nv = await scripted(0)
  const changed: string[] = []
  let volumeUpdates = 0
  nv.addEventListener('change', (e) => changed.push(e.detail.property))
  nv.addEventListener('volumeUpdated', () => volumeUpdates++)
  await nv.resetSettings()
  expect(changed).toEqual(
    expect.arrayContaining([
      'sliceType',
      'azimuth',
      'gamma',
      'backgroundColor',
    ]),
  )
  expect(volumeUpdates).toBeGreaterThan(0)
  // A second reset changes nothing, so it announces no settings.
  changed.length = 0
  await nv.resetSettings()
  expect(changed).toEqual([])
})
