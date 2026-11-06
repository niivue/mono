import { expect } from '@playwright/test'
import { test } from './sharedPage'

// #461: changing the device pixel ratio (or the canvas size) resized the view
// but kept instance tiles sized for the old canvas. #200:
// effectiveDevicePixelRatio is the ratio the canvas actually renders at.

test('instance tiles follow the canvas pixel size', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:200px;height:100px'
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2', devicePixelRatio: 1 })
    await nv.attachToCanvas(canvas)
    // A tiny in-memory volume: the test is about tile sizes, not the data.
    const { createNiftiArray } = await import('/src/volume/utils.ts')
    const img = new Uint8Array(8 ** 3).fill(100)
    const affine = [1, 0, 0, -4, 0, 1, 0, -4, 0, 0, 1, -4, 0, 0, 0, 1]
    const nii = createNiftiArray([8, 8, 8], [1, 1, 1], affine, 2, img)
    await nv.loadVolumes([{ url: new File([nii], 'v.nii'), name: 'v' }])
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
    const setter = widths()
    await nv.reinitializeView({
      forceDevicePixelRatio: 3,
      forceRestart: false,
    })
    const reinitialize = widths()
    // A CSS resize reaches the view through its ResizeObserver.
    canvas.style.width = '100px'
    const deadline = performance.now() + 5000
    while (canvas.width !== 300 && performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return { before, setter, reinitialize, cssResize: widths() }
  })
  expect(r.before).toEqual([100, 100])
  expect(r.setter).toEqual([200, 200])
  expect(r.reinitialize).toEqual([300, 300])
  expect(r.cssResize).toEqual([150, 150])
})

test('controllers sharing a canvas follow one ratio', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:200px;height:100px'
    document.body.appendChild(canvas)
    const half = (x0: number, x1: number) =>
      new NiiVue({
        backend: 'webgl2',
        devicePixelRatio: 1,
        bounds: [
          [x0, 0],
          [x1, 1],
        ],
      })
    const left = half(0, 0.5)
    const right = half(0.5, 1)
    await left.attachToCanvas(canvas)
    await right.attachToCanvas(canvas)
    left.devicePixelRatio = 2
    const box = canvas.getBoundingClientRect()
    // The center of the right half, in client pixels.
    const at = right.clientToCanvas(box.left + 150, box.top + 50)
    return {
      ratios: [left.effectiveDevicePixelRatio, right.effectiveDevicePixelRatio],
      canvasWidth: canvas.width,
      at,
    }
  })
  expect(r.canvasWidth).toBe(400)
  expect(r.ratios).toEqual([2, 2])
  // 50 CSS px into a 100 CSS px half, at 2x.
  expect(r.at).toEqual([100, 100])
})

// Its own page: the shared one is fixed at 1x. Opened here rather than by
// `test.use({ deviceScaleFactor })`, which would give this one test a worker of
// its own, launched last, after the rest of the suite.
test.describe('on a 2x screen', () => {
  test('effectiveDevicePixelRatio is the ratio the canvas renders at', async ({
    browser,
  }) => {
    // At 1x a helper that always returned 1 would pass the auto checks.
    const { baseURL, viewport } = test.info().project.use
    const page = await browser.newPage({
      baseURL,
      viewport,
      deviceScaleFactor: 2,
    })
    await page.goto('/examples/index.html', { waitUntil: 'load' })
    const r = await page.evaluate(async () => {
      const { default: NiiVue } = await import('/src/index.ts')
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:200px;height:100px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({ backend: 'webgl2' })
      await nv.attachToCanvas(canvas)
      const read = () => [
        nv.effectiveDevicePixelRatio,
        canvas.width / canvas.getBoundingClientRect().width,
      ]
      const auto = read()
      nv.devicePixelRatio = 3
      const forced = read()
      nv.devicePixelRatio = -1
      return { window: window.devicePixelRatio, auto, forced, back: read() }
    })
    await page.close()
    expect(r.window).toBe(2)
    expect(r.auto).toEqual([2, 2])
    expect(r.forced).toEqual([3, 3])
    expect(r.back).toEqual([2, 2])
  })
})
