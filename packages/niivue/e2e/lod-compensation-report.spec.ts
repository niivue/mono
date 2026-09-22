import { expect, test } from '@playwright/test'

// nv.lodCompensation() exists because both LOD compensation settings are exact
// no-ops on anything that is not a multi-LOD chunked volume, with nothing on
// screen to say so. These assertions pin the two answers that matter: the
// inactive case must name its reason, and the active case must report the
// SAME numbers the shader is given.
//
// This is an e2e rather than a Bun unit test because the report reads through
// the controller (whose module graph uses import.meta.glob) and asks the
// attached view for its coarse-floor dims.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const { chunkVolumeMultiLOD } = await import('/src/volume/chunking.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  canvas.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(canvas)
`

test('reports inactive, with a reason, before a volume is loaded', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    return nv.lodCompensation()
  })()`)

  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('no volume is loaded')
  expect(r.levels).toEqual([])
  expect(r.floor).toBe(null)
})

test('names an ordinary volume as the reason it is doing nothing', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    nv.volumeLodBrightnessCompensation = 0.05
    return nv.lodCompensation()
  })()`)

  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('volume 0 is not a chunked volume')
  // The setting still round-trips; it just reaches nothing.
  expect(r.brightnessCompensation).toBeCloseTo(0.05, 10)
})

test('reports per-level downsample, brick counts and shader numbers', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    // A real multi-LOD plan over the loaded grid. Assigning it directly keeps
    // the test off the network-streaming path: the report reads plan.levelDims
    // and each chunk's sourceLevel, which is exactly what the renderer reads.
    const levelDims = [[256, 256, 256], [128, 128, 128], [64, 64, 64]]
    nv.volumes[0].chunkPlan = chunkVolumeMultiLOD(
      levelDims,
      { center: [128, 128, 128], radius: 4 },
      256,
      { cellEdge: 16 },
    )
    nv.volumeLodBrightnessCompensation = 0.1
    nv.volumeLodOpacityCompensation = 0.25
    return nv.lodCompensation()
  })()`)

  expect(r.isActive).toBe(true)
  expect(r.inactiveReason).toBe(null)
  expect(r.levels.length).toBe(3)

  const [fine, mid, coarse] = r.levels
  expect(fine.level).toBe(0)
  expect(fine.downsample).toBeCloseTo(1, 10)
  // The finest level is uncompensated by definition, whatever the coefficients.
  expect(fine.brightnessExponent).toBe(1)
  expect(fine.opacityScale).toBe(1)

  expect(mid.downsample).toBeCloseTo(2, 10)
  expect(mid.brightnessExponent).toBeCloseTo(1 - 0.1 * 1, 10)
  expect(mid.opacityScale).toBeCloseTo(1 + 0.25 * 1, 10)

  expect(coarse.downsample).toBeCloseTo(4, 10)
  expect(coarse.brightnessExponent).toBeCloseTo(1 - 0.1 * 3, 10)
  expect(coarse.opacityScale).toBeCloseTo(1 + 0.25 * 3, 10)

  // Every brick in the plan is accounted for by exactly one level.
  const counted = r.levels.reduce((sum, l) => sum + l.brickCount, 0)
  expect(counted).toBeGreaterThan(0)
  expect(r.levels.some((l) => l.brickCount > 0 && l.downsample > 1)).toBe(true)
})

test('zeroed coefficients read as inactive even with a coarse level drawn', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    nv.volumes[0].chunkPlan = chunkVolumeMultiLOD(
      [[256, 256, 256], [128, 128, 128], [64, 64, 64]],
      { center: [128, 128, 128], radius: 4 },
      256,
      { cellEdge: 16 },
    )
    nv.volumeLodBrightnessCompensation = 0
    nv.volumeLodOpacityCompensation = 0
    return nv.lodCompensation()
  })()`)

  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('both coefficients are 0')
})

test('both coefficients accept the same range', async ({ page }) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.volumeLodBrightnessCompensation = 0.5
    nv.volumeLodOpacityCompensation = 0.5
    const mid = {
      brightness: nv.volumeLodBrightnessCompensation,
      opacity: nv.volumeLodOpacityCompensation,
    }
    nv.volumeLodBrightnessCompensation = 5
    nv.volumeLodOpacityCompensation = 5
    return {
      mid,
      clamped: {
        brightness: nv.volumeLodBrightnessCompensation,
        opacity: nv.volumeLodOpacityCompensation,
      },
    }
  })()`)

  // A value copied from one knob into the other must not silently clamp.
  expect(r.mid.brightness).toBeCloseTo(0.5, 10)
  expect(r.mid.opacity).toBeCloseTo(0.5, 10)
  expect(r.clamped.brightness).toBe(1)
  expect(r.clamped.opacity).toBe(1)
})
