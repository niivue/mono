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

const BIG = 800

for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const alpha of [255, 128]) {
    test(`a hidden label's outline has no seams (${backend}, alpha ${alpha})`, async ({
      page,
    }) => {
      const ready = await page.evaluate(mount(backend))
      test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
      // A big font gives a box with a few pixels of bar to sample (#478).
      const box = await page.evaluate(`(async () => {
      const nv = window.__nv
      nv.isLegendVisible = true
      const c = nv.canvas
      // Nothing behind the canvas may show through a translucent swatch.
      for (const el of [...document.body.children]) if (el !== c) el.remove()
      c.width = c.height = ${BIG}
      c.style.width = c.style.height = '${BIG}px'
      nv.fontMinSize = 30
      nv.resize()
      await nv.setVolume(1, { hiddenLabels: [nv.model.collectLegendEntries()[0].labelValue] })
      // The legend reads the LUT each frame; a translucent colour must not
      // blend twice where an outline's sides meet.
      const cm = nv.volumes[1].colormapLabel
      const first = nv.model.collectLegendEntries()[0].labelValue
      cm.lut[(first - (cm.min ?? 0)) * 4 + 3] = ${alpha}
      await window.__frame()
      const l = nv.view.legendLayout
      return { x: l.x + l.margin, y: l.y, size: l.boxSize }
    })()`)
      const png = await page.screenshot({
        clip: { x: 0, y: 0, width: BIG, height: BIG },
      })
      // Distance of each row of the left bar's middle column from the bar's
      // middle row: a seam is a row fading toward the backing.
      const worst = await page.evaluate(
        async ([b64, b]) => {
          const blob = await (
            await fetch(`data:image/png;base64,${b64}`)
          ).blob()
          const bmp = await createImageBitmap(blob)
          const c = new OffscreenCanvas(bmp.width, bmp.height)
          const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
          ctx.drawImage(bmp, 0, 0)
          const { data, width } = ctx.getImageData(0, 0, bmp.width, bmp.height)
          const t = Math.max(1, Math.round(b.size * 0.2))
          const x = Math.floor(b.x + t / 2)
          const px = (y: number) => {
            const o = (y * width + x) * 4
            return [data[o], data[o + 1], data[o + 2]]
          }
          const ref = px(Math.floor(b.y + b.size / 2))
          let max = 0
          for (
            let y = Math.ceil(b.y) + 1;
            y < Math.floor(b.y + b.size) - 1;
            y++
          ) {
            const p = px(y)
            max = Math.max(max, ...p.map((v, i) => Math.abs(v - (ref[i] ?? 0))))
          }
          return max
        },
        [png.toString('base64'), box] as const,
      )
      expect(box.size).toBeGreaterThan(20)
      expect(worst).toBeLessThan(8)
    })
  }
}
