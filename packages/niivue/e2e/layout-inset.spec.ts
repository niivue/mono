import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// layoutInset keeps a strip of the canvas clear of tiles, colorbar, legend and
// graph, while overlay renderers still get the whole view: an in-canvas
// control panel (the uikit controls demo) owns the strip.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 120_000 })

const SIZE = 300
const INSET = 120

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`layoutInset clears a strip for an overlay (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html', { waitUntil: 'load' })
    const r = await page.evaluate(
      async ({ backend, SIZE, INSET }) => {
        if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
          return null
        const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
        document.body.innerHTML = ''
        const c = document.createElement('canvas')
        c.width = c.height = SIZE
        c.style.cssText = `position:fixed;left:0;top:0;width:${SIZE}px;height:${SIZE}px`
        document.body.appendChild(c)
        const nv = new NiiVue({
          backend,
          sliceType: SLICE_TYPE.AXIAL,
          backgroundColor: [0, 0, 0, 1],
          isColorbarVisible: true,
          isOrientationTextVisible: false,
          forceDevicePixelRatio: 1,
          layoutInset: [INSET, 0, 0, 0],
        })
        let overlayWidth = 0
        nv.registerOverlayRenderer({
          drawOverlay: (f: { bounds: { width: number } }) => {
            overlayWidth = f.bounds.width
          },
        })
        await nv.attachToCanvas(c)
        await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
        await new Promise((res) =>
          requestAnimationFrame(() => requestAnimationFrame(res)),
        )
        return {
          tileLeft: nv.view.screenSlices[0].leftTopWidthHeight[0],
          colorbarOrigin: nv.view.colorbarRenderer.getLayout().originX,
          overlayWidth,
        }
      },
      { backend, SIZE, INSET },
    )
    test.skip(!r, 'no WebGPU adapter')
    expect(r?.tileLeft).toBeGreaterThanOrEqual(INSET)
    expect(r?.colorbarOrigin).toBe(INSET)
    expect(r?.overlayWidth).toBe(SIZE)
    // Nothing but background in the reserved strip.
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: INSET - 2, height: SIZE },
    })
    const lit = await page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const ctx = document
        .createElement('canvas')
        .getContext('2d') as CanvasRenderingContext2D
      ctx.canvas.width = img.width
      ctx.canvas.height = img.height
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, img.width, img.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4)
        if (d[i] + d[i + 1] + d[i + 2] > 30) n++
      return n
    }, png.toString('base64'))
    expect(lit).toBe(0)
  })
}

test('a bad layoutInset is stored as zero sides (#494)', async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.layoutInset = null as never
    const fromNull = nv.layoutInset
    nv.layoutInset = [Number.NaN, -5, 10, 0]
    const fromBad = nv.layoutInset
    // A document bypasses the setter, so it must be normalized on load.
    nv.model.layout.inset = null as never
    const doc = nv.serializeDocument()
    nv.layoutInset = [1, 1, 1, 1]
    await nv.loadDocument(new File([doc], 'inset.nvd'))
    return { fromNull, fromBad, fromDoc: nv.layoutInset }
  })
  expect(r.fromNull).toEqual([0, 0, 0, 0])
  expect(r.fromBad).toEqual([0, 0, 10, 0])
  expect(r.fromDoc).toEqual([0, 0, 0, 0])
})
