import { expect, test } from '@playwright/test'

// #461: changing the device pixel ratio (or the canvas size) resized the view
// but kept instance tiles sized for the old canvas. #200:
// effectiveDevicePixelRatio is the ratio the canvas actually renders at.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('instance tiles follow the canvas pixel size', async ({ page }) => {
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

test.describe('on a 2x screen', () => {
  // At 1x a helper that always returned 1 would pass the auto checks.
  test.use({ deviceScaleFactor: 2 })

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
    expect(r.window).toBe(2)
    expect(r.auto).toEqual([2, 2])
    expect(r.forced).toEqual([3, 3])
    expect(r.back).toEqual([2, 2])
  })
})
