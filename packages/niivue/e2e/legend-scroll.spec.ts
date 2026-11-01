import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// A legend too tall for the canvas scrolls: the wheel honours every
// WheelEvent.deltaMode, and a press on the scrollbar thumb is the legend's,
// never a camera drag.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const SIZE = 400
// WheelEvent.deltaMode values (WheelEvent is browser-only).
const DELTA_PIXEL = 0
const DELTA_LINE = 1
const DELTA_PAGE = 2

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
    sliceType: SLICE_TYPE.RENDER,
    isLegendVisible: true,
    forceDevicePixelRatio: 1,
  })
  await nv.attachToCanvas(c)
  await nv.addColormapFromUrl('/volumes/aal.json')
  await nv.loadVolumes([
    { url: '/volumes/mni152.nii.gz' },
    { url: '/volumes/aal.nii.gz', colormap: 'aal' },
  ])
  window.__nv = nv
  window.__frame = async () => { await nextFrame(); await nextFrame() }
  await window.__frame()
  return { ok: true, backend: nv.backend }
})()`

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`legend scrolls by wheel mode, thumb press is not a camera drag (${backend})`, async ({
    page,
  }) => {
    const ready = await page.evaluate(mount(backend))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    expect(ready.backend).toBe(backend)

    const layout = () =>
      page.evaluate(`(() => {
        const l = window.__nv.view.legendLayout
        const h = l.visibleRows * l.pitch - l.gap
        return {
          rows: l.rows, visibleRows: l.visibleRows, scrollRow: l.scrollRow,
          pitch: l.pitch,
          center: [l.x + l.width / 2, l.y + h / 2],
          thumb: [
            l.x + l.width - l.margin / 2,
            l.y + (h * (l.scrollRow + l.visibleRows / 2)) / l.rows,
          ],
        }
      })()`)
    const wheel = async (deltaY: number, deltaMode: number) => {
      const l = await layout()
      await page.evaluate(
        ([x, y, deltaY, deltaMode]) => {
          const c = document.querySelector('canvas') as HTMLCanvasElement
          c.dispatchEvent(
            new WheelEvent('wheel', {
              clientX: x,
              clientY: y,
              deltaY,
              deltaMode,
              bubbles: true,
              cancelable: true,
            }),
          )
        },
        [l.center[0], l.center[1], deltaY, deltaMode],
      )
      await page.evaluate('window.__frame()')
      return (await layout()).scrollRow
    }

    const start = await layout()
    expect(start.rows).toBeGreaterThan(start.visibleRows)
    expect(start.scrollRow).toBe(0)
    expect(await wheel(3, DELTA_LINE)).toBe(3)
    expect(await wheel(1, DELTA_PAGE)).toBe(3 + start.visibleRows)
    expect(await wheel(start.pitch, DELTA_PIXEL)).toBe(4 + start.visibleRows)

    const camera = () =>
      page.evaluate('[window.__nv.azimuth, window.__nv.elevation]')
    const before = await camera()
    const l = await layout()
    await page.mouse.move(l.thumb[0], l.thumb[1])
    await page.mouse.down()
    await page.mouse.move(l.thumb[0], l.thumb[1] + 40, { steps: 5 })
    await page.mouse.up()
    expect(await camera()).toEqual(before)
  })
}
