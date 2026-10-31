import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// Per-label visibility: a volume's hiddenLabels draw transparent in 2D and 3D
// on both backends, a legend colour-box click toggles one when
// isLegendToggleEnabled is on (a name click still moves the crosshair), and
// documents keep the hidden set.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const SIZE = 256

/**
 * Colourful pixels on a grid over the canvas: the anatomy is gray, so only
 * atlas colour counts. The screenshot is decoded by the page's own 2D canvas.
 */
async function colourful(page: Page): Promise<number> {
  const png = await page.screenshot({
    clip: { x: 0, y: 0, width: SIZE, height: SIZE },
  })
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bmp, 0, 0)
    const { data, width, height } = ctx.getImageData(
      0,
      0,
      bmp.width,
      bmp.height,
    )
    let n = 0
    for (let y = 4; y < height; y += 8) {
      for (let x = 4; x < width; x += 8) {
        const o = (y * width + x) * 4
        const r = data[o]
        const g = data[o + 1]
        const b = data[o + 2]
        if (Math.max(r, g, b) - Math.min(r, g, b) > 30) n++
      }
    }
    return n
  }, png.toString('base64'))
}

const mount = (backend: string): string => `(async () => {
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' }
    if (!(await navigator.gpu.requestAdapter())) return { ok: false, why: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const nextFrame = () => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)))
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.style.cssText = 'position:fixed;top:0;left:0;width:${SIZE}px;height:${SIZE}px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: '${backend}',
    sliceType: SLICE_TYPE.AXIAL,
    backgroundColor: [0, 0, 0, 1],
    isLegendVisible: false,
    isOrientCubeVisible: false,
    isOrientationTextVisible: false,
    is3DCrosshairVisible: false,
    crosshairWidth: 0,
  })
  await nv.attachToCanvas(c)
  await nv.addColormapFromUrl('/volumes/aal.json')
  await nv.loadVolumes([
    { url: '/volumes/mni152.nii.gz', calMin: 30, calMax: 80 },
    { url: '/volumes/aal.nii.gz', colormap: 'aal' },
  ])
  await nextFrame()
  window.__nv = nv
  window.__frame = async () => { await nextFrame(); await nextFrame() }
  return { ok: true, backend: nv.backend }
})()`

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`hidden labels stop rendering in 2D and 3D (${backend})`, async ({
    page,
  }) => {
    const ready = await page.evaluate(mount(backend))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    expect(ready.backend).toBe(backend)

    const show = async (hide: boolean, sliceType: number) => {
      await page.evaluate(
        `(async () => {
          const nv = window.__nv
          nv.sliceType = ${sliceType}
          const lut = nv.volumes[1].colormapLabel
          const all = Array.from({ length: lut.lut.length / 4 }, (_, i) => (lut.min ?? 0) + i)
          await nv.setVolume(1, { hiddenLabels: ${hide} ? all : [] })
          await window.__frame()
        })()`,
      )
      return colourful(page)
    }
    for (const sliceType of [0, 4]) {
      const shown = await show(false, sliceType)
      const hidden = await show(true, sliceType)
      const again = await show(false, sliceType)
      expect(shown, `sliceType ${sliceType}`).toBeGreaterThan(20)
      expect(hidden, `sliceType ${sliceType}`).toBe(0)
      expect(again, `sliceType ${sliceType}`).toBe(shown)
    }
  })
}

test('legend box click toggles a label, name click moves the crosshair, documents keep it', async ({
  page,
}) => {
  const ready = await page.evaluate(mount('webgl2'))
  expect(ready.ok).toBe(true)
  const at = await page.evaluate(`(async () => {
    const nv = window.__nv
    nv.isLegendVisible = true
    nv.isLegendToggleEnabled = true
    await window.__frame()
    const l = nv.view.legendLayout
    const e = l.entries[0]
    const y = l.y + l.boxSize / 2
    return {
      box: [l.x + l.margin + l.boxSize / 2, y],
      name: [l.x + l.margin + l.boxSize + l.textPadding + 4, y],
      value: e.labelValue,
    }
  })()`)
  const hidden = () =>
    page.evaluate('window.__nv.volumes[1].hiddenLabels ?? []')
  const crosshair = () => page.evaluate('Array.from(window.__nv.crosshairPos)')

  await page.mouse.click(at.box[0], at.box[1])
  expect(await hidden()).toEqual([at.value])
  await page.evaluate('window.__frame()')
  // The hidden entry stays listed so it can be shown again.
  expect(
    await page.evaluate(`window.__nv.model.collectLegendEntries()[0].isHidden`),
  ).toBe(true)

  const before = await crosshair()
  await page.mouse.click(at.name[0], at.name[1])
  expect(await crosshair()).not.toEqual(before)
  expect(await hidden()).toEqual([at.value])

  const reloaded = await page.evaluate(`(async () => {
    const nv = window.__nv
    await nv.loadDocument(new File([nv.serializeDocument()], 'h.nvd'))
    await window.__frame()
    return nv.volumes[1].hiddenLabels
  })()`)
  expect(reloaded).toEqual([at.value])

  await page.mouse.click(at.box[0], at.box[1])
  expect(await hidden()).toEqual([])

  // Off (the default): a box click navigates instead.
  await page.evaluate('window.__nv.isLegendToggleEnabled = false')
  await page.mouse.click(at.box[0], at.box[1])
  expect(await hidden()).toEqual([])
})
