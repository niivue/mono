import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// fontScale and fontMinSize resize the text at once, from the setter and from
// a loaded document, without an explicit resize() (#377).

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 120_000 })

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`font size follows the setters and documents (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html', { waitUntil: 'load' })
    const r = await page.evaluate(async (backend) => {
      if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
        return null
      const { default: NiiVue } = await import('/src/index.ts')
      // fontScale is an exponent on the canvas area over 800x600, which has no
      // effect below that size.
      const c = document.createElement('canvas')
      c.style.cssText = 'position:fixed;left:0;top:0;width:1600px;height:1200px'
      document.body.appendChild(c)
      const nv = new NiiVue({
        backend,
        isColorbarVisible: true,
        forceDevicePixelRatio: 1,
      })
      await nv.attachToCanvas(c)
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      const px = () => nv.view.fontRenderer.fontPx
      const scale0 = nv.fontScale
      const base = px()
      nv.fontScale = 2
      const scaled = px()
      const doc = nv.serializeDocument()
      nv.fontScale = scale0
      const reset = px()
      await nv.loadDocument(new File([doc], 'f.nvd'))
      const loaded = px()
      nv.fontScale = scale0
      nv.fontMinSize = 60
      return { base, scaled, reset, loaded, minSized: px() }
    }, backend)
    test.skip(!r, 'no WebGPU adapter')
    expect(r?.scaled).toBeGreaterThan(r?.base ?? 0)
    expect(r?.reset).toBe(r?.base)
    expect(r?.loaded).toBe(r?.scaled)
    expect(r?.minSized).toBeGreaterThan(r?.base ?? 0)
  })
}
