import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'

// The crosshair API mixes units: setCrosshairPos / getCrosshairPos are RAS
// world mm, while the crosshairPos property and NiiVueOptions.crosshairPos are
// a scene fraction across the scene bounding box.

async function setup() {
  const nv = new NiiVue({ backend: 'webgl2', crosshairPos: [0.25, 0.5, 0.75] })
  const initial = Array.from(nv.crosshairPos)
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  const lo = Array.from(nv.model.extentsMin)
  const hi = Array.from(nv.model.extentsMax)
  const toFrac = (mm: number[]) =>
    mm.map((v, i) => (v - lo[i]) / (hi[i] - lo[i]))
  return { nv, initial, toFrac }
}

test('setCrosshairPos and getCrosshairPos are world mm; crosshairPos is a scene fraction', async () => {
  const { nv, initial, toFrac } = await setup()
  const mm: [number, number, number] = [-37.5, 12.25, 41]
  nv.setCrosshairPos(mm)
  const frac = Array.from(nv.crosshairPos)
  const back = nv.getCrosshairPos()
  nv.setCrosshairPos([1e4, -1e4, 0])
  const clampedFrac = Array.from(nv.crosshairPos)
  nv.crosshairPos = [1.5, -0.25, 0.5]
  const asGiven = Array.from(nv.crosshairPos)

  // NiiVueOptions.crosshairPos is stored as the fraction it was given.
  expect(initial).toEqual([0.25, 0.5, 0.75])
  // mm in, fraction of the scene bounding box stored, the same mm out.
  const expectedFrac = toFrac(mm)
  for (let i = 0; i < 3; i++) {
    expect(frac[i]).toBeCloseTo(expectedFrac[i], 5)
    expect(back[i]).toBeCloseTo(mm[i], 3)
  }
  // setCrosshairPos clamps to the scene bounding box.
  expect(clampedFrac[0]).toBe(1)
  expect(clampedFrac[1]).toBe(0)
  // The property neither clamps nor snaps.
  expect(asGiven).toEqual([1.5, -0.25, 0.5])
})

test('setCrosshairPos snaps to a background voxel centre when enabled', async () => {
  const { nv } = await setup()
  nv.isSnapToVoxelCenters = true
  const mm: [number, number, number] = [10.3, -20.6, 5.2]
  nv.setCrosshairPos(mm)
  const snapped = nv.getCrosshairPos()
  nv.setCrosshairPos(snapped)
  const again = nv.getCrosshairPos()
  const pixDims = Array.from(nv.volumes[0].pixDimsRAS ?? []).slice(1, 4)
  expect(pixDims).toHaveLength(3)
  for (let i = 0; i < 3; i++) {
    // Within half a voxel of the request, and a fixed point of the snap.
    expect(Math.abs(snapped[i] - mm[i])).toBeLessThanOrEqual(
      pixDims[i] / 2 + 1e-4,
    )
    expect(again[i]).toBeCloseTo(snapped[i], 4)
  }
  expect(Array.from(snapped)).not.toEqual(mm)
})
