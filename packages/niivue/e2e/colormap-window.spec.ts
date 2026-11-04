import { expect, test } from '@playwright/test'

// CT scans are calibrated in Hounsfield units, so each CT colormap is designed for
// one window (ct_kidneys 114..302, ct_bones 180..600) stored as min/max in its LUT.
// Setting such a colormap fills any bound not given from that window; a given
// bound wins, NaN means the image's own default, generic colormaps (e.g. gray)
// never change the window, and re-sending the current colormap keeps it (#395).

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const mount = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
`

test('CT colormaps apply their Hounsfield window', async ({ page }) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${mount}
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz', colormap: 'ct_bones', calMax: NaN }])
    const v = nv.volumes[0]
    const win = () => [v.calMin, v.calMax]
    const out = { load: win(), robust: [v.robustMin, v.robustMax] }
    await nv.setVolume(0, { colormap: 'ct_kidneys' })
    out.kidneys = win()
    await nv.setVolume(0, { colormap: 'gray', calMax: 500 })
    out.gray = win()
    await nv.setVolume(0, { colormap: 'ct_kidneys', calMin: -1024 })
    out.oneBound = win()
    await nv.setVolume(0, { calMin: 0 })
    await nv.setVolume(0, { colormap: 'ct_kidneys' })
    out.resent = win()
    await nv.setVolume(0, { calMin: NaN, calMax: NaN })
    out.reset = win()
    return out
  })()`)
  const [lo, hi] = r.robust
  expect(r).toEqual({
    load: [180, hi],
    robust: [lo, hi],
    kidneys: [114, 302],
    gray: [114, 500],
    oneBound: [-1024, 302],
    resent: [0, 302],
    reset: [lo, hi],
  })
})

test('a streamed volume takes the CT window and auto-windows only a NaN bound', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${mount}
    const N = 32
    const source = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [N, N, 4], spacing: [1, 1, 1] }],
      fetchChunk: async ({ texOrigin: o, texDims: d }) => {
        const out = new Int16Array(d[0] * d[1] * d[2])
        for (let i = 0; i < out.length; i++) out[i] = (o[0] + (i % d[0])) * 100
        return new Uint8Array(out.buffer)
      },
    }
    await nv.loadChunkedVolume(source, { colormap: 'ct_bones', calMax: NaN })
    const v = () => nv.volumes[0]
    for (let i = 0; i < 100 && !(v()?.robustMax > 1); i++)
      await new Promise((r) => setTimeout(r, 50))
    return [v().calMin, v().calMax, v().robustMax]
  })()`)
  expect(r[0]).toBe(180)
  expect(r[1]).toBe(r[2])
  expect(r[1]).toBeGreaterThan(600)
})
