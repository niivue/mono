import { expect, test } from '@playwright/test'

// CT scans are calibrated in Hounsfield units, so each CT colormap is designed for
// one window (ct_kidneys 114..302, ct_bones 180..600) stored as min/max in its LUT.
// Setting such a colormap applies that window unless calMin/calMax are given;
// generic colormaps (e.g. gray) never change the window.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('CT colormaps apply their Hounsfield window', async ({ page }) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz', colormap: 'ct_bones' }])
    const v = nv.volumes[0]
    const win = () => [v.calMin, v.calMax]
    const out = { load: win() }
    await nv.setVolume(0, { colormap: 'ct_kidneys' })
    out.kidneys = win()
    await nv.setVolume(0, { colormap: 'gray' })
    out.gray = win()
    await nv.setVolume(0, { colormap: 'ct_kidneys', calMin: -1024 })
    out.explicit = win()
    return out
  })()`)
  expect(r).toEqual({
    load: [180, 600],
    kidneys: [114, 302],
    gray: [114, 302],
    explicit: [-1024, 302],
  })
})
