import { expect, type Page, test } from '@playwright/test'

// A matcap is fetched when a volume is uploaded for rendering, so whether one
// that fails to load still lets the volume draw is only observable in a live
// renderer. Headless Chromium here has no WebGPU adapter, so this covers the
// WebGL2 renderer; the WebGPU one carries the same fallback.

async function render(
  page: Page,
  matcap: string | null,
  noMatcaps = false,
): Promise<Buffer> {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
  await page.evaluate(
    async ([matcap, noMatcaps]) => {
      const { default: NiiVue } = await import('/src/index.ts')
      const canvas = document.createElement('canvas')
      canvas.id = 'matcap-canvas'
      canvas.width = 256
      canvas.height = 256
      document.body.prepend(canvas)
      const nv = new NiiVue({
        backend: 'webgl2',
        ...(noMatcaps ? { matcaps: {} } : {}),
      })
      await nv.attachToCanvas(canvas)
      nv.sliceType = 4 // render: the only view that samples the matcap
      // Without lighting the shader never samples the matcap, and every matcap,
      // even plain white, draws the same picture.
      nv.volumeIllumination = 0.5
      if (matcap !== null) nv.volumeMatcap = matcap
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      await new Promise((resolve) => setTimeout(resolve, 1000))
    },
    [matcap, noMatcaps] as const,
  )
  return page.locator('#matcap-canvas').screenshot()
}

test('a matcap that fails to load draws the volume with the default matcap', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().startsWith('niivue-warn'))
      warnings.push(m.text())
  })

  const withDefault = await render(page, null)
  warnings.length = 0
  const withMissing = await render(page, '/missing/Gold.jpg')
  // With no matcaps there is no default, so the volume draws plain white.
  const withWhite = await render(page, '/missing/Gold.jpg', true)

  expect(warnings.some((w) => w.includes('updateVolume failed'))).toBe(false)
  expect(
    warnings.some(
      (w) =>
        w.includes('/missing/Gold.jpg') &&
        w.includes('drawing the default matcap'),
    ),
  ).toBe(true)
  // The same picture as the default matcap, not a blank canvas.
  expect(withMissing.equals(withDefault)).toBe(true)
  // And the default matcap is visible: plain white draws differently.
  expect(withWhite.equals(withDefault)).toBe(false)
})
