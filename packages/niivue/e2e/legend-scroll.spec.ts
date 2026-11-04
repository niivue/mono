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

  test(`legend scroll resets when its source changes, not otherwise (${backend})`, async ({
    page,
  }) => {
    const ready = await page.evaluate(mount(backend))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    const steps = await page.evaluate(`(async () => {
      const nv = window.__nv
      const row = () => nv.view.legendLayout?.scrollRow ?? -1
      // A slow renderer may not have drawn yet: wait for the expected reset.
      const until0 = async () => {
        for (let i = 0; i < 120 && row() !== 0; i++) await window.__frame()
        return row()
      }
      const settle = async () => {
        for (let i = 0; i < 10; i++) await window.__frame()
        return row()
      }
      const scroll = async () => {
        nv.model._legendScrollRow = 5
        nv.drawScene()
        await settle()
      }
      const out = {}
      await scroll()
      out.scrolled = row()
      nv.azimuth = nv.azimuth + 30
      out.afterRedraw = await settle()
      await nv.setVolume(1, { hiddenLabels: [3] })
      out.afterToggle = await settle()
      await nv.addColormapFromUrl('/volumes/aal.json', 'aal2')
      await nv.setVolume(1, { colormap: 'aal2' })
      out.afterColormap = await until0()
      await scroll()
      await nv.addVolume({ url: '/volumes/aal.nii.gz', colormap: 'aal', name: 'aal_b.nii.gz' })
      out.afterLoad = await until0()
      await scroll()
      await nv.removeVolume(2)
      out.afterRemove = await until0()
      await scroll()
      const doc = nv.serializeDocument()
      await nv.loadDocument(new File([doc], 'd.nvd'))
      out.afterDocument = await until0()
      return out
    })()`)
    expect(steps).toEqual({
      scrolled: 5,
      afterRedraw: 5,
      afterToggle: 5,
      afterColormap: 0,
      afterLoad: 0,
      afterRemove: 0,
      afterDocument: 0,
    })
  })
}
