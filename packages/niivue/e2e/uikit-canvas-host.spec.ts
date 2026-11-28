import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// @niivue/uikit on a bare canvas, no NiiVue: UIKitCanvasHost from the built
// bundle (run `nx build uikit` first) draws the standalone demo's triangle
// (apps/demo-uikit/triangle.js) and a UIKit toggle over it; a real click on
// the toggle hides the triangle, a second shows it again (a state leak from
// the overlays into the app's next frame would fail that). The app's draw
// leaves a right-half scissor: the toggle (left) and the next clear must not
// be clipped by it.
const here = path.dirname(fileURLToPath(import.meta.url))
const uikit = path.resolve(here, '../../uikit')
const triangle = path.resolve(here, '../../../apps/demo-uikit/triangle.js')

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`UIKitCanvasHost draws app content and controls on bare ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const box = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
        return null
      const { UIKitCanvasHost, UIKitControls, loadDefaultFont } = await import('/@fs/${uikit}/dist/uikit.js')
      const { UIKitToggleOverlay } = await import('/@fs/${uikit}/dist/controls.js')
      const { createTriangle } = await import('/@fs/${triangle}')
      const c = document.createElement('canvas')
      c.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'
      document.body.appendChild(c)
      const triangle = createTriangle()
      window.__visible = true
      const host = await UIKitCanvasHost.create(c, {
        backend: '${backend}',
        clearColor: [0, 0, 0, 1],
        draw: (f) => {
          if (window.__visible) triangle.draw(f, {
            cx: 200 * f.dpr, cy: 100 * f.dpr, radius: 60 * f.dpr, angle: 0, color: [1, 0, 0, 1],
          })
          // An app may leave a scissor and viewport over part of the canvas:
          // the host must give overlays and the next clear the whole canvas.
          const w = c.width, h = c.height
          if (f.handle.backend === 'webgl2') {
            const gl = f.handle.gl
            gl.enable(gl.SCISSOR_TEST)
            gl.scissor(w / 2, 0, w / 2, h)
            gl.viewport(w / 2, 0, w / 2, h)
          } else f.handle.pass.setScissorRect(w / 2, 0, w / 2, h)
        },
      })
      const toggles = new UIKitToggleOverlay(await loadDefaultFont(), { cssUnits: true })
      toggles.addToggle({ id: 'show', label: 'Show', x: 10, y: 10, checked: true,
        onChange: (on) => { window.__visible = on } })
      const controls = new UIKitControls().add(toggles)
      host.registerOverlayRenderer(controls)
      const detach = controls.attach(host)
      window.__done = () => { detach(); host.destroy() }
      // Read the frame back in the rAF after the host's, before it is presented.
      window.__sample = () => new Promise((resolve) => {
        host.drawScene()
        requestAnimationFrame(() => {
          const g = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }).getContext('2d')
          g.drawImage(c, 0, 0)
          const s = c.width / 300
          const at = (x, y) => Array.from(g.getImageData(x * s, y * s, 1, 1).data)
          const t = toggles.getLayout('show')
          const lit = g.getImageData(t.x * s, t.y * s, t.width * s, t.height * s).data
          let toggle = 0
          for (let i = 0; i < lit.length; i += 4) if (lit[i] + lit[i + 1] + lit[i + 2] > 120) toggle++
          resolve({ backend: host.backend, triangle: at(200, 110), toggle })
        })
      })
      const t = toggles.getLayout('show')
      return { x: t.box.x + t.box.size / 2, y: t.box.y + t.box.size / 2 }
    })()`)
    test.skip(!box, 'no WebGPU adapter')
    const { x, y } = box as { x: number; y: number }
    try {
      const sample = () =>
        page.evaluate('window.__sample()') as Promise<{
          backend: string
          triangle: number[]
          toggle: number
        }>
      const on = await sample()
      expect(on.backend).toBe(backend)
      expect(on.triangle).toEqual([255, 0, 0, 255])
      expect(on.toggle).toBeGreaterThan(20)
      await page.mouse.click(x, y)
      expect(await page.evaluate('window.__visible')).toBe(false)
      expect((await sample()).triangle).toEqual([0, 0, 0, 255])
      await page.mouse.click(x, y)
      expect((await sample()).triangle).toEqual([255, 0, 0, 255])
    } finally {
      await page.evaluate('window.__done?.()')
    }
  })
}
