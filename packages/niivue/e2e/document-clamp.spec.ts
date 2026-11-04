import { expect, test } from '@playwright/test'

// loadDocument writes settings straight into the model, past the setters, so it
// must apply their clamps itself (#387).

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('a document cannot set an out-of-range sampleRate or renderMode', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    const out: [number, number][] = []
    for (const bad of [0, Number.NaN, 1e9]) {
      // Bypass the setters to write a document holding the bad values.
      nv.model.volume.sampleRate = bad
      nv.model.volume.renderMode = bad
      const doc = nv.serializeDocument()
      await nv.loadDocument(new File([doc], 'bad.nvd'))
      out.push([nv.volumeSampleRate, nv.volumeRenderMode])
    }
    return out
  })
  expect(r).toEqual([
    [1, 0],
    [2, 0],
    [4, 0],
  ])
})

test('a document cannot set the other clamped settings out of range', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    const out: number[][] = []
    for (const bad of [Number.NaN, -3, 1e9]) {
      // Bypass the setters to write a document holding the bad values.
      const m = nv.model
      m.scene.gamma = bad
      m.volume.lodBrightnessCompensation = bad
      m.volume.lodOpacityCompensation = bad
      m.volume.gradientOpacity = bad
      m.volume.silhouette = bad
      m.mesh.xRay = bad
      const doc = nv.serializeDocument()
      await nv.loadDocument(new File([doc], 'bad.nvd'))
      out.push([
        nv.gamma,
        nv.volumeLodBrightnessCompensation,
        nv.volumeLodOpacityCompensation,
        nv.volumeGradientOpacity,
        nv.volumeSilhouette,
        nv.meshXRay,
      ])
    }
    return out
  })
  // NaN gives each setter's default; -3 and 1e9 clamp to the range ends.
  expect(r).toEqual([
    [1, 0.08, 0, 0, 0, 0],
    [0.1, 0, 0, 0, 0, 0],
    [10, 1, 1, 1, 1, 1],
  ])
})
