import { expect, test } from '@playwright/test'

// The volume-load worker exists to keep the main thread responsive during gzip
// decompression + NIfTI parse. It never actually ran: nifti-reader-js declares
// several NIFTI1 methods as class FIELDS (own properties), and structured clone
// rejects a function, so posting the NVImage back always threw and every load
// silently fell back to a main-thread decode.
//
// `hdrTransfer` sends a data-only header snapshot and rebuilds the instance on
// receipt. These tests pin both halves: the worker is used (no fallback warning),
// and the rehydrated header still behaves like a NIFTI1.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const loadVolume = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  c.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
`

test('the volume-load worker is used, not the main-thread fallback', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })

  const voxels = await page.evaluate(`(async () => {
    ${loadVolume}
    return nv.volumes[0].img.length
  })()`)

  expect(voxels).toBeGreaterThan(1_000_000)
  // The tell-tale of the bug. Any structured-clone failure lands here.
  expect(warnings.join('\n')).not.toContain('volumeLoad worker failed')
})

test('the header survives the worker round-trip with its methods intact', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${loadVolume}
    const h = nv.volumes[0].hdr
    return {
      ctor: h.constructor?.name,
      hasDatatypeFn: typeof h.getDatatypeCodeString === 'function',
      datatypeStr: h.getDatatypeCodeString(h.datatypeCode),
      formatted: typeof h.toFormattedString === 'function'
        ? h.toFormattedString().slice(0, 20)
        : null,
      // No snapshot marker should leak into the live header.
      leakedMarker: '__hdrKind' in h,
      dims: Array.from(h.dims.slice(0, 4)),
      datatypeCode: h.datatypeCode,
    }
  })()`)

  // Vite's dev transform renames the class (`_NIFTI1`), so match the suffix.
  expect(r.ctor).toMatch(/NIFTI1$/)
  expect(r.hasDatatypeFn).toBe(true)
  expect(typeof r.datatypeStr).toBe('string')
  expect(r.datatypeStr.length).toBeGreaterThan(0)
  expect(r.formatted).toBeTruthy()
  expect(r.leakedMarker).toBe(false)
  // mni152 is a 3-D volume with real dims.
  expect(r.dims[0]).toBe(3)
  expect(r.dims[1]).toBeGreaterThan(1)
  expect(r.datatypeCode).toBeGreaterThan(0)
})
