import { expect, test } from '@playwright/test'

// A `.HEAD` URL given without `urlImageData` is paired with the `.BRIK` or
// `.BRIK.gz` beside it in `NVModel.prepareVolume`. The URL derivation and the
// probe order are unit-tested in src/volume/pairedImage.test.ts against a fake
// fetch; this holds the wiring through the real controller, load worker and
// AFNI reader, which the Bun runner cannot import. The dev images ship only
// `DT_*+orig.BRIK.gz`, so every inferred load here takes the `.gz` fallback.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  c.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
`

/** Paths of every request the page (and its workers) makes from now on. */
function recordRequests(page: import('@playwright/test').Page): string[] {
  const paths: string[] = []
  page.on('request', (r) => paths.push(new URL(r.url()).pathname))
  return paths
}

test('a .HEAD URL alone loads with the .BRIK.gz beside it', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const requested = recordRequests(page)
  const r = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{ url: '/volumes/afni/DT_FA+orig.HEAD' }])
    const v = nv.volumes[0]
    return { dims: Array.from(v.hdr.dims.slice(1, 4)), paired: v._urlImageData }
  })()`)
  expect(r.paired).toBe('/volumes/afni/DT_FA+orig.BRIK.gz')
  expect(r.dims.every((d: number) => d > 1)).toBe(true)
  // The uncompressed .BRIK was probed first and found missing.
  expect(requested).toContain('/volumes/afni/DT_FA+orig.BRIK')
})

test('an explicit urlImageData is used as given, without a probe', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const requested = recordRequests(page)
  const paired = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{
      url: '/volumes/afni/DT_FA+orig.HEAD',
      urlImageData: '/volumes/afni/DT_FA+orig.BRIK.gz',
    }])
    return nv.volumes[0]._urlImageData
  })()`)
  expect(paired).toBe('/volumes/afni/DT_FA+orig.BRIK.gz')
  expect(requested).not.toContain('/volumes/afni/DT_FA+orig.BRIK')
})

test('a deferred 4D reload reuses the inferred data URL', async ({ page }) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([
      { url: '/volumes/afni/DT_V1+orig.HEAD', limitFrames4D: 1 },
    ])
    const before = nv.volumes[0].nFrame4D
    await nv.loadDeferred4DVolumes(nv.volumes[0].id)
    return { before, after: nv.volumes[0].nFrame4D }
  })()`)
  expect(r).toEqual({ before: 1, after: 3 })
})

test('a non-AFNI load makes no pairing requests', async ({ page }) => {
  test.setTimeout(90_000)
  const requested = recordRequests(page)
  await page.evaluate(`(async () => {
    ${setup}
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  })()`)
  expect(requested.filter((p) => /brik|\.img$/i.test(p))).toEqual([])
})
