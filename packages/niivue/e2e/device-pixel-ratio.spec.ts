import { expect, test } from '@playwright/test'

// #461: the devicePixelRatio setter resized the view but kept instance tiles
// sized for the old canvas. #200: effectiveDevicePixelRatio is the ratio the
// canvas actually renders at.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('instance tiles follow a devicePixelRatio change', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:200px;height:100px'
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2', devicePixelRatio: 1 })
    await nv.attachToCanvas(canvas)
    await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz', name: 'v' }])
    await nv.setInstances([
      {
        id: 'left',
        volumeId: 'v',
        bounds: [
          [0, 0],
          [0.5, 1],
        ],
      },
      {
        id: 'right',
        volumeId: 'v',
        bounds: [
          [0.5, 0],
          [1, 1],
        ],
      },
    ])
    const widths = () => nv.getScreenTiles().map((t) => t.leftTopWidthHeight[2])
    const before = widths()
    nv.devicePixelRatio = 2
    return { canvasWidth: canvas.width, before, after: widths() }
  })
  expect(r.before).toEqual([100, 100])
  expect(r.canvasWidth).toBe(400)
  expect(r.after).toEqual([200, 200])
})

test('effectiveDevicePixelRatio is the ratio the canvas renders at', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:200px;height:100px'
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    const ratio = () => canvas.width / canvas.getBoundingClientRect().width
    const auto = [nv.effectiveDevicePixelRatio, ratio()]
    nv.devicePixelRatio = 3
    const forced = [nv.effectiveDevicePixelRatio, ratio()]
    nv.devicePixelRatio = -1
    return {
      auto,
      forced,
      back: nv.effectiveDevicePixelRatio,
      window: window.devicePixelRatio,
    }
  })
  expect(r.auto).toEqual([r.window, r.window])
  expect(r.forced).toEqual([3, 3])
  expect(r.back).toBe(r.window)
})
