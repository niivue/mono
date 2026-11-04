import { expect, test } from '@playwright/test'

// The crosshair API mixes units: setCrosshairPos / getCrosshairPos are RAS
// world mm, while the crosshairPos property and NiiVueOptions.crosshairPos are
// a scene fraction across the scene bounding box. Both live on the controller,
// whose module graph the Bun runner cannot import, so the units are pinned here
// through the public API of a real instance.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 128
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: 'webgl2', crosshairPos: [0.25, 0.5, 0.75] })
  const initial = Array.from(nv.crosshairPos)
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  const lo = Array.from(nv.model.extentsMin)
  const hi = Array.from(nv.model.extentsMax)
  const toFrac = (mm) => mm.map((v, i) => (v - lo[i]) / (hi[i] - lo[i]))
`

test('setCrosshairPos and getCrosshairPos are world mm; crosshairPos is a scene fraction', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    const mm = [-37.5, 12.25, 41]
    nv.setCrosshairPos(mm)
    const frac = Array.from(nv.crosshairPos)
    const back = nv.getCrosshairPos()
    nv.setCrosshairPos([1e4, -1e4, 0])
    const clampedFrac = Array.from(nv.crosshairPos)
    nv.crosshairPos = [1.5, -0.25, 0.5]
    const asGiven = Array.from(nv.crosshairPos)
    return { initial, lo, hi, mm, frac, expectedFrac: toFrac(mm), back, clampedFrac, asGiven }
  })()`)
  // NiiVueOptions.crosshairPos is stored as the fraction it was given.
  expect(r.initial).toEqual([0.25, 0.5, 0.75])
  // mm in, fraction of the scene bounding box stored, the same mm out.
  for (let i = 0; i < 3; i++) {
    expect(r.frac[i]).toBeCloseTo(r.expectedFrac[i], 5)
    expect(r.back[i]).toBeCloseTo(r.mm[i], 3)
  }
  // setCrosshairPos clamps to the scene bounding box.
  expect(r.clampedFrac[0]).toBe(1)
  expect(r.clampedFrac[1]).toBe(0)
  // The property neither clamps nor snaps.
  expect(r.asGiven).toEqual([1.5, -0.25, 0.5])
})

test('setCrosshairPos snaps to a background voxel centre when enabled', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.isSnapToVoxelCenters = true
    const mm = [10.3, -20.6, 5.2]
    nv.setCrosshairPos(mm)
    const snapped = nv.getCrosshairPos()
    nv.setCrosshairPos(snapped)
    const again = nv.getCrosshairPos()
    const pixDims = nv.volumes[0].pixDimsRAS.slice(1, 4)
    return { mm, snapped, again, pixDims }
  })()`)
  for (let i = 0; i < 3; i++) {
    // Within half a voxel of the request, and a fixed point of the snap.
    expect(Math.abs(r.snapped[i] - r.mm[i])).toBeLessThanOrEqual(
      r.pixDims[i] / 2 + 1e-4,
    )
    expect(r.again[i]).toBeCloseTo(r.snapped[i], 4)
  }
  expect(r.snapped).not.toEqual(r.mm)
})
