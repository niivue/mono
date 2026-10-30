import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// Guards the macos-15 full-suite job (issue #199). Most GPU specs skip when no
// adapter is available, so a runner image or Chromium build that quietly falls
// back to SwiftShader would leave that job green while testing almost nothing.
// Only meaningful in hardware mode; the default SwiftShader runs skip it.
test.use({ launchOptions: webgpuLaunchOptions })

test('hardware mode reaches a real GPU on both backends', async ({ page }) => {
  test.skip(
    !process.env.PLAYWRIGHT_CHROMIUM_CHANNEL,
    'PLAYWRIGHT_CHROMIUM_CHANNEL unset: SwiftShader by design',
  )
  // A served page, not about:blank: navigator.gpu needs a secure context.
  await page.goto('/examples/index.html', { waitUntil: 'load' })
  const gpu = await page.evaluate(`(async () => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null
    return {
      webgl2: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl),
      webgpu: adapter ? adapter.info.vendor + ' ' + adapter.info.architecture : null,
      fallback: adapter ? adapter.info.isFallbackAdapter : null,
    }
  })()`)
  expect(gpu.webgl2).not.toMatch(/swiftshader|llvmpipe|null/i)
  expect(gpu.webgpu).not.toBeNull()
  expect(gpu.fallback).toBe(false)
})
