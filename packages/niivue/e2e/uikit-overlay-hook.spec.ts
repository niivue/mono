import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// The built, self-contained @niivue/uikit bundle (no runtime imports), loaded via
// Vite's /@fs/ escape hatch. A bare `@niivue/uikit` specifier is not rewritten
// inside a page.evaluate string (Vite only transforms real modules), so we point
// at the file directly. Requires `nx build uikit` to have run.
const uikitDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../uikit/dist/uikit.js',
)

// The UIKit overlay lifecycle hook gives a registered renderer one privileged
// draw per frame, at the end of the frame, on the live backend. These specs pin
// the core seam end to end on a real WebGL2 context: the callback fires, it is
// handed a well-formed frame (usable backend handle, device-pixel bounds, dpr,
// settled flag), unregister stops it, and a UIKit line overlay can draw into the
// same frame without throwing. Rendering correctness (pixels) is verified visually
// via the ruler demo; here we prove the plumbing.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// No volume needed: the hook fires on every frame regardless of scene contents,
// so skipping the fetch keeps the spec independent of the Git-LFS sample volumes.
const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 300; c.height = 200
  c.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
`

test('overlay hook fires with a well-formed WebGL2 frame', async ({ page }) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    let calls = 0
    let last = null
    let viewport = null
    nv.registerOverlayRenderer({
      drawOverlay(frame) {
        calls++
        last = {
          backend: frame.handle.backend,
          isGL: frame.handle.gl instanceof WebGL2RenderingContext,
          width: frame.bounds.width,
          height: frame.bounds.height,
          dpr: frame.dpr,
          settledType: typeof frame.settled,
        }
        // Prove the handle is a live context mid-frame: a real gl call must work.
        viewport = Array.from(frame.handle.gl.getParameter(frame.handle.gl.VIEWPORT))
      },
    })
    nv.drawScene()
    await nextFrame()
    return { calls, last, viewport }
  })()`)

  expect(r.calls).toBeGreaterThan(0)
  expect(r.last.backend).toBe('webgl2')
  expect(r.last.isGL).toBe(true)
  expect(r.last.width).toBeGreaterThan(0)
  expect(r.last.height).toBeGreaterThan(0)
  expect(r.last.dpr).toBeGreaterThan(0)
  expect(r.last.settledType).toBe('boolean')
  // Viewport is a 4-tuple with a positive drawable size.
  expect(r.viewport).toHaveLength(4)
  expect(r.viewport[2]).toBeGreaterThan(0)
  expect(r.viewport[3]).toBeGreaterThan(0)
})

test('unregister stops the overlay callback', async ({ page }) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    let calls = 0
    const renderer = { drawOverlay() { calls++ } }
    const off = nv.registerOverlayRenderer(renderer)
    nv.drawScene()
    await nextFrame()
    const afterRegister = calls
    off()
    nv.drawScene()
    await nextFrame()
    nv.drawScene()
    await nextFrame()
    return { afterRegister, afterUnregister: calls }
  })()`)

  expect(r.afterRegister).toBeGreaterThan(0)
  // No further calls once unregistered, across subsequent frames.
  expect(r.afterUnregister).toBe(r.afterRegister)
})

test('a UIKit line overlay draws into the frame without throwing', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    const { UIKitLineOverlay, buildLine } = await import('/@fs/${uikitDist}')
    const overlay = new UIKitLineOverlay([
      buildLine(10, 10, 250, 150, 4, [1, 0.2, 0.2, 1]),
    ])
    let error = null
    // Surface a draw-time throw (shader compile / gl error) instead of swallowing it.
    const orig = overlay.drawOverlay.bind(overlay)
    let drew = 0
    nv.registerOverlayRenderer({
      drawOverlay(frame) {
        try { orig(frame); drew++ } catch (e) { error = String(e && e.message || e) }
      },
    })
    nv.drawScene()
    await nextFrame()
    const glError = nv.view.gl.getError()
    overlay.destroy()
    return { drew, error, glError }
  })()`)

  expect(r.error).toBeNull()
  expect(r.drew).toBeGreaterThan(0)
  // 0 === gl.NO_ERROR: the UIKit draw left the context clean.
  expect(r.glError).toBe(0)
})
